import { createHash } from 'node:crypto';
import { Inject, Injectable, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';

import { CLOCK } from '../../../../shared/application/ports/clock.port';
import type { Clock } from '../../../../shared/application/ports/clock.port';
import { CORRELATION_CONTEXT } from '../../../../shared/application/ports/correlation-context.port';
import type { CorrelationContext } from '../../../../shared/application/ports/correlation-context.port';
import { LOGGER } from '../../../../shared/application/ports/logger.port';
import type { AppLogger } from '../../../../shared/application/ports/logger.port';
import { METRICS } from '../../../../shared/application/ports/metrics.port';
import type { Metrics } from '../../../../shared/application/ports/metrics.port';
import { UNIT_OF_WORK } from '../../../../shared/application/ports/unit-of-work.port';
import type { UnitOfWork } from '../../../../shared/application/ports/unit-of-work.port';
import { ProcessWagerTransactionUseCase } from '../../../wagering/application/process-wager-transaction.use-case';
import { PAYLOAD_HASHER } from '../../../wagering/application/ports/payload-hasher.port';
import type { PayloadHasher } from '../../../wagering/application/ports/payload-hasher.port';
import { INBOX_CLAIM_REPOSITORY } from '../../inbox/application/ports/inbox-claim.port';
import type { InboxClaimRepository } from '../../inbox/application/ports/inbox-claim.port';
import { InboxMessage } from '../../inbox/domain/inbox-message';
import { ConsumerLifecycle } from './consumer-lifecycle';
import {
  DisabledSqsFaultInjection,
  SQS_FAULT_INJECTION,
  SqsInjectedCrashError,
} from './ports/sqs-fault-injection.port';
import type { SqsFaultInjection } from './ports/sqs-fault-injection.port';
import type { MessageConsumer, ReceivedMessage } from './ports/message-consumer.port';
import { MESSAGE_CONSUMER } from './ports/message-consumer.port';
import { SQS_CONFIG } from './ports/sqs-config.port';
import type { SqsConfig } from './ports/sqs-config.port';
import { classifySqsFailure, failureCode } from './sqs-failure-classifier';
import { WagerTransactionRequestedEnvelope } from './wager-transaction-requested.envelope';

export interface SqsProcessingOutcome {
  action: 'ACK' | 'RETRY';
  classification?: 'BUSINESS' | 'REPLAY' | 'PERMANENT' | 'TRANSIENT';
}

export class InboxPayloadConflictError extends Error {
  constructor(readonly messageId: string) {
    super(`SQS_INBOX_PAYLOAD_CONFLICT_${messageId}`);
    this.name = 'InboxPayloadConflictError';
  }
}

@Injectable()
export class SqsWagerTransactionConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly lifecycle = new ConsumerLifecycle();
  private loopPromise?: Promise<void>;
  private readonly inFlight = new Set<Promise<unknown>>();

  constructor(
    @Inject(MESSAGE_CONSUMER) private readonly messageConsumer: MessageConsumer,
    @Inject(INBOX_CLAIM_REPOSITORY) private readonly inboxRepository: InboxClaimRepository,
    private readonly processWagerTransaction: ProcessWagerTransactionUseCase,
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(CORRELATION_CONTEXT) private readonly correlationContext: CorrelationContext,
    @Inject(PAYLOAD_HASHER) private readonly payloadHasher: PayloadHasher,
    @Inject(LOGGER) private readonly logger: AppLogger,
    @Inject(METRICS) private readonly metrics: Metrics,
    @Inject(SQS_CONFIG) private readonly config: SqsConfig,
    @Optional() @Inject(SQS_FAULT_INJECTION) private readonly faultInjection: SqsFaultInjection = new DisabledSqsFaultInjection(),
  ) {}

  onModuleInit(): void {
    if (this.config.enabled) {
      this.metrics.increment('sqs_consumer_lifecycle_total', { event: 'started' });
      this.logger.info('sqs.consumer.started', {
        consumerName: this.config.consumerName,
        instanceId: this.config.instanceId,
      });
      this.loopPromise = this.pollLoop();
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.metrics.increment('sqs_consumer_lifecycle_total', { event: 'shutdown_requested' });
    this.logger.info('sqs.consumer.shutdown.requested', {
      consumerName: this.config.consumerName,
      instanceId: this.config.instanceId,
    });
    this.lifecycle.requestShutdown();
    await this.faultInjection.checkpoint('DURING_SHUTDOWN');
    if (this.loopPromise) {
      await this.loopPromise;
    }
    await Promise.allSettled([...this.inFlight]);
    this.metrics.increment('sqs_consumer_lifecycle_total', { event: 'shutdown_completed' });
    this.logger.info('sqs.consumer.shutdown.completed', {
      consumerName: this.config.consumerName,
      instanceId: this.config.instanceId,
    });
  }

  async processMessage(message: ReceivedMessage): Promise<SqsProcessingOutcome> {
    if (!this.lifecycle.beginMessage()) {
      this.metrics.increment('sqs_consumer_lifecycle_total', { event: 'message_rejected_during_shutdown' });
      await this.messageConsumer.changeVisibility(message, 0);
      return { action: 'RETRY', classification: 'TRANSIENT' };
    }
    const startedAt = Date.now();
    const correlationId = extractCorrelationId(message.body)
      ?? extractMessageId(message.body)
      ?? message.brokerMessageId;
    const task = this.correlationContext.run(
      this.correlationContext.resolve(correlationId),
      () => this.processMessageInternal(message),
    );
    this.inFlight.add(task);
    try {
      return await task;
    } finally {
      this.inFlight.delete(task);
      this.lifecycle.completeMessage();
      this.metrics.observe?.('processing_duration_ms', Date.now() - startedAt, {
        operation: 'SQS_CONSUME',
        source: 'SQS',
      });
    }
  }

  private async processMessageInternal(message: ReceivedMessage): Promise<SqsProcessingOutcome> {
    this.metrics.increment('sqs_messages_total', { queue: 'input', outcome: 'received' });
    if (message.receiveCount > 1) {
      this.metrics.increment('sqs_redeliveries_total', { queue: 'input' });
      this.logger.info('sqs.consumer.redelivery', {
        consumerName: this.config.consumerName,
        instanceId: this.config.instanceId,
        receiveCount: String(message.receiveCount),
      });
    }
    let envelope: WagerTransactionRequestedEnvelope;
    try {
      envelope = WagerTransactionRequestedEnvelope.parse(message.body);
    } catch (error) {
      const messageId = extractMessageId(message.body);
      if (messageId) {
        await this.persistFailure(messageId, rawPayloadHash(message.body), 'PERMANENT', failureCode(error));
      }
      await this.handleInvalidMessage(message, error);
      this.metrics.increment('sqs_messages_total', { queue: 'input', outcome: 'invalid_envelope' });
      this.metrics.increment('sqs_dlq_messages_total', { queue: 'input', reason: 'invalid_envelope' });
      return { action: 'RETRY', classification: 'PERMANENT' };
    }

    const payloadHash = envelope.payloadHash(this.payloadHasher);
    try {
      const claimed = await this.inboxRepository.claim({
        consumerName: this.config.consumerName,
        messageId: envelope.messageId,
        payloadHash,
        claimedBy: this.config.instanceId,
        now: this.clock.now(),
        leaseDurationMs: this.config.inboxLeaseSeconds * 1000,
      });

      if (claimed.kind === 'PAYLOAD_CONFLICT') {
        this.metrics.increment('sqs_inbox_claim_total', { outcome: 'payload_conflict' });
        await this.messageConsumer.changeVisibility(message, 0);
        this.metrics.increment('sqs_messages_total', { queue: 'input', outcome: 'permanent_failure' });
        return { action: 'RETRY', classification: 'PERMANENT' };
      }
      if (claimed.kind === 'FAILED_PERMANENT') {
        this.metrics.increment('sqs_inbox_claim_total', { outcome: 'failed_permanent' });
        await this.messageConsumer.changeVisibility(message, 0);
        this.metrics.increment('sqs_messages_total', { queue: 'input', outcome: 'permanent_failure' });
        return { action: 'RETRY', classification: 'PERMANENT' };
      }
      if (claimed.kind === 'IN_FLIGHT') {
        this.metrics.increment('sqs_inbox_claim_total', { outcome: 'in_flight' });
        const retrySeconds = Math.max(1, Math.ceil((claimed.leaseUntil.getTime() - this.clock.now().getTime()) / 1000));
        await this.messageConsumer.changeVisibility(message, retrySeconds);
        this.metrics.increment('sqs_messages_total', { queue: 'input', outcome: 'in_flight' });
        return { action: 'RETRY', classification: 'TRANSIENT' };
      }
      if (claimed.kind === 'PROCESSED') {
        this.metrics.increment('sqs_inbox_claim_total', { outcome: 'processed' });
        await this.messageConsumer.delete(message);
        this.metrics.increment('sqs_messages_total', { queue: 'input', outcome: 'replay' });
        this.metrics.increment('wager_replays_total', { kind: envelope.data.kind, source: 'SQS' });
        this.logger.info('sqs.consumer.replay', {
          consumerName: this.config.consumerName,
          instanceId: this.config.instanceId,
        });
        return { action: 'ACK', classification: 'REPLAY' };
      }

      this.metrics.increment('sqs_inbox_claim_total', { outcome: 'claimed' });

      const outcome = await this.unitOfWork.execute(async () => {
        const inbox = await this.inboxRepository.find(this.config.consumerName, envelope.messageId);
        if (!inbox || !inbox.hasPayloadHash(payloadHash)) {
          throw new InboxPayloadConflictError(envelope.messageId);
        }
        await this.faultInjection.checkpoint('BEFORE_COMMIT');
        const result = await this.processWagerTransaction.execute(envelope.toCommand(), 'SQS');
        inbox.markProcessed(this.clock.now());
        await this.inboxRepository.update(inbox);
        this.logger.info('sqs.wager_transaction.processed', {
          consumerName: this.config.consumerName,
          messageId: envelope.messageId,
          transactionId: result.transactionId,
          status: result.status,
          idempotentReplay: result.idempotentReplay,
          attempt: message.receiveCount,
        });
        return {
          action: 'ACK' as const,
          classification: result.status === 'REJECTED' || result.status === 'PENDING_REFERENCE'
            ? 'BUSINESS' as const
            : undefined,
        };
      });

      if (outcome.action === 'ACK') {
        await this.faultInjection.checkpoint('AFTER_COMMIT_BEFORE_ACK');
        await this.messageConsumer.delete(message);
        this.metrics.increment('sqs_messages_total', {
          queue: 'input',
          outcome: 'ack',
        });
      }
      return outcome;
    } catch (error) {
      if (error instanceof SqsInjectedCrashError) throw error;
      const classification = error instanceof InboxPayloadConflictError
        ? 'PERMANENT'
        : classifySqsFailure(error);
      const code = error instanceof InboxPayloadConflictError ? 'INBOX_PAYLOAD_CONFLICT' : failureCode(error);

      if (!(error instanceof InboxPayloadConflictError)) {
        await this.persistFailure(envelope.messageId, payloadHash, classification, code);
      }

      if (classification === 'PERMANENT') {
        await this.messageConsumer.changeVisibility(message, 0);
        this.metrics.increment('sqs_messages_total', { queue: 'input', outcome: 'permanent_failure' });
        this.metrics.increment('sqs_dlq_messages_total', { queue: 'input', reason: code });
        this.logger.error('sqs.wager_transaction.permanent_failure', {
          consumerName: this.config.consumerName,
          messageId: envelope.messageId,
          classification,
          errorCode: code,
          attempt: message.receiveCount,
        });
        return { action: 'RETRY', classification };
      }

      const retryIndex = Math.min(Math.max(message.receiveCount - 1, 0), this.config.retryBackoffSeconds.length - 1);
      const visibilityTimeout = this.config.retryBackoffSeconds[retryIndex] ?? 300;
      await this.messageConsumer.changeVisibility(message, visibilityTimeout);
      this.metrics.increment('sqs_messages_total', { queue: 'input', outcome: 'retry' });
      this.metrics.increment('wager_retries_total', {
        kind: envelope.data.kind,
        source: 'SQS',
        reason: classification,
      });
      this.logger.warn('sqs.wager_transaction.retry', {
        consumerName: this.config.consumerName,
        messageId: envelope.messageId,
        classification,
        errorCode: code,
        attempt: message.receiveCount,
        visibilityTimeout,
      });
      return { action: 'RETRY', classification };
    }
  }

  private async handleInvalidMessage(message: ReceivedMessage, error: unknown): Promise<void> {
    await this.messageConsumer.changeVisibility(message, 0);
    this.logger.error('sqs.wager_transaction.invalid_envelope', {
      consumerName: this.config.consumerName,
      brokerMessageId: message.brokerMessageId,
      classification: 'PERMANENT',
      errorCode: failureCode(error),
      attempt: message.receiveCount,
    });
  }

  private async persistFailure(
    messageId: string,
    payloadHash: string,
    classification: 'TRANSIENT' | 'PERMANENT',
    errorCode: string,
  ): Promise<void> {
    await this.unitOfWork.execute(async () => {
      const inbox = await this.inboxRepository.find(this.config.consumerName, messageId);
      const now = this.clock.now();
      if (!inbox) {
        const created = InboxMessage.receive({
          consumerName: this.config.consumerName,
          messageId,
          payloadHash,
          receivedAt: now,
        });
        if (classification === 'PERMANENT') {
          created.markPermanent(errorCode, now);
        } else {
          created.markRetryable(errorCode, now);
        }
        await this.inboxRepository.save(created);
        return;
      }
      if (!inbox.hasPayloadHash(payloadHash) || inbox.status === 'PROCESSED') {
        return;
      }
      if (classification === 'PERMANENT') {
        inbox.markPermanent(errorCode, now);
      } else {
        inbox.markRetryable(errorCode, now);
      }
      await this.inboxRepository.update(inbox);
    });
  }

  private async pollLoop(): Promise<void> {
    while (this.lifecycle.canReceive()) {
      try {
        const messages = await this.messageConsumer.receive();
        if (messages.length === 0) {
          await delay(100);
          continue;
        }
        await Promise.all(messages.map((message) => this.processMessage(message)));
      } catch (error) {
        this.metrics.increment('sqs_consumer_poll_errors_total', {
          error: error instanceof SqsInjectedCrashError ? 'injected_crash' : 'poll_failure',
        });
        this.logger.error('sqs.consumer.poll_failed', {
          consumerName: this.config.consumerName,
          errorCode: failureCode(error),
        });
        await delay(1000);
      }
    }
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function extractMessageId(raw: string): string | undefined {
  try {
    const value = JSON.parse(raw) as { messageId?: unknown };
    return typeof value.messageId === 'string' && value.messageId.trim() ? value.messageId : undefined;
  } catch {
    return undefined;
  }
}

function extractCorrelationId(raw: string): string | undefined {
  try {
    const value = JSON.parse(raw) as { correlationId?: unknown };
    return typeof value.correlationId === 'string' && value.correlationId.trim()
      ? value.correlationId
      : undefined;
  } catch {
    return undefined;
  }
}

function rawPayloadHash(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

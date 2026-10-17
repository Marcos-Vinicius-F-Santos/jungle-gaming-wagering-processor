import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';

import { CLOCK } from '../../../../shared/application/ports/clock.port';
import type { Clock } from '../../../../shared/application/ports/clock.port';
import { CORRELATION_CONTEXT } from '../../../../shared/application/ports/correlation-context.port';
import type { CorrelationContext } from '../../../../shared/application/ports/correlation-context.port';
import type { HealthComponent, OutboxPublisherHealth } from '../../../../interfaces/health/application/ports/health.port';
import { LOGGER } from '../../../../shared/application/ports/logger.port';
import type { AppLogger } from '../../../../shared/application/ports/logger.port';
import { METRICS } from '../../../../shared/application/ports/metrics.port';
import type { Metrics } from '../../../../shared/application/ports/metrics.port';
import { UNIT_OF_WORK } from '../../../../shared/application/ports/unit-of-work.port';
import type { UnitOfWork } from '../../../../shared/application/ports/unit-of-work.port';
import { MESSAGE_PUBLISHER } from './ports/message-publisher.port';
import type { MessagePublisher } from './ports/message-publisher.port';
import { OUTBOX_PUBLISHER_CONFIG } from './ports/outbox-publisher-config.port';
import type { OutboxPublisherConfig } from './ports/outbox-publisher-config.port';
import { OUTBOX_REPOSITORY } from './ports/outbox-repository.port';
import type { OutboxRepository } from './ports/outbox-repository.port';
import type { OutboxMessage } from '../domain/outbox-message';

@Injectable()
export class OutboxPublisherWorker implements OnModuleInit, OnModuleDestroy, OutboxPublisherHealth {
  private readonly claimToken: string;
  private stopping = false;
  private loopPromise?: Promise<void>;
  private readonly inFlight = new Set<Promise<unknown>>();
  private lastFailureCode?: string;
  private lastFailureAt?: Date;
  private lastPendingCount = 0;
  private lastLagSeconds = 0;

  constructor(
    @Inject(OUTBOX_REPOSITORY) private readonly repository: OutboxRepository,
    @Inject(MESSAGE_PUBLISHER) private readonly publisher: MessagePublisher,
    @Inject(OUTBOX_PUBLISHER_CONFIG) private readonly config: OutboxPublisherConfig,
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(CORRELATION_CONTEXT) private readonly correlationContext: CorrelationContext,
    @Inject(LOGGER) private readonly logger: AppLogger,
    @Inject(METRICS) private readonly metrics: Metrics,
  ) {
    this.claimToken = `${config.publisherName}:${uuidv7()}`.slice(0, 100);
  }

  onModuleInit(): void {
    if (this.config.enabled) {
      this.loopPromise = this.pollLoop();
    }
  }

  getStatus(): HealthComponent {
    if (!this.config.enabled) {
      return { component: 'outboxPublisher', status: 'disabled' };
    }
    if (this.lastFailureCode) {
      return {
        component: 'outboxPublisher',
        status: 'degraded',
        errorCode: this.lastFailureCode,
        pendingCount: this.lastPendingCount,
        lagSeconds: this.lastLagSeconds,
        lastErrorAt: this.lastFailureAt?.toISOString(),
      };
    }
    return {
      component: 'outboxPublisher',
      status: 'up',
      pendingCount: this.lastPendingCount,
      lagSeconds: this.lastLagSeconds,
    };
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.loopPromise) await this.loopPromise;
    await Promise.allSettled([...this.inFlight]);
  }

  async publishNextBatch(): Promise<number> {
    const now = this.clock.now();
    const leaseUntil = new Date(now.getTime() + this.config.claimTimeoutSeconds * 1000);
    const messages = await this.unitOfWork.execute(() => this.repository.claimDue({
      now,
      limit: this.config.batchSize,
      publisherName: this.claimToken,
      leaseUntil,
    }));

    if (messages.length > 0) {
      this.metrics.increment('outbox_events_total', { outcome: 'selected' });
    }
    await Promise.all(messages.map((message) => this.processMessage(message)));
    await this.recordLag(now);
    return messages.length;
  }

  private async processMessage(message: OutboxMessage): Promise<void> {
    const task = this.correlationContext.run(message.correlationId, () => this.processMessageInternal(message));
    this.inFlight.add(task);
    try {
      await task;
    } finally {
      this.inFlight.delete(task);
    }
  }

  private async processMessageInternal(message: OutboxMessage): Promise<void> {
    const startedAt = Date.now();
    try {
      if (message.attempts >= this.config.retryBackoffSeconds.length) {
        await this.publishDeadLetter(message, 'OUTBOX_RETRY_LIMIT');
        return;
      }

      await this.publisher.publish(message);
      this.lastFailureCode = undefined;
      this.lastFailureAt = undefined;
      const confirmed = await this.repository.markPublished(this.eventId(message), this.claimToken, this.clock.now());
      this.metrics.increment('outbox_events_total', { outcome: confirmed ? 'published' : 'already_confirmed' });
      this.logger.info('outbox.event.published', {
        eventId: message.eventId,
        eventType: message.eventType,
        aggregateId: message.aggregateId,
        publisherName: this.claimToken,
        attempt: message.attempts + 1,
        confirmed,
      });
    } catch (error) {
      const errorCode = failureCode(error);
      this.lastFailureCode = errorCode;
      this.lastFailureAt = this.clock.now();
      this.metrics.increment('outbox_events_total', { outcome: 'publish_failed' });
      this.logger.warn('outbox.event.publish_failed', {
        eventId: message.eventId,
        eventType: message.eventType,
        aggregateId: message.aggregateId,
        publisherName: this.claimToken,
        attempt: message.attempts + 1,
        errorCode,
      });

      if (message.attempts + 1 >= this.config.retryBackoffSeconds.length) {
        await this.publishDeadLetter(message, errorCode);
        return;
      }

      await this.scheduleRetry(message, errorCode);
    } finally {
      this.metrics.observe?.('processing_duration_ms', Date.now() - startedAt, {
        operation: 'OUTBOX_PUBLISH',
        source: 'OUTBOX',
      });
      this.metrics.observe?.('outbox_publish_duration_ms', Date.now() - startedAt, { outcome: 'completed' });
    }
  }

  private async publishDeadLetter(message: OutboxMessage, errorCode: string): Promise<void> {
    try {
      await this.publisher.publishToDeadLetter(message);
      const marked = await this.repository.markIntervention(
        message.eventId,
        this.claimToken,
        this.clock.now(),
        errorCode,
      );
      this.metrics.increment('outbox_events_total', { outcome: marked ? 'dead_lettered' : 'already_intervening' });
      if (marked) this.metrics.increment('sqs_dlq_messages_total', { queue: 'events', reason: errorCode });
      this.logger.error('outbox.event.dead_lettered', {
        eventId: message.eventId,
        eventType: message.eventType,
        aggregateId: message.aggregateId,
        publisherName: this.claimToken,
        errorCode,
        marked,
      });
    } catch (error) {
      const deadLetterErrorCode = failureCode(error);
      this.lastFailureCode = `DLQ_${deadLetterErrorCode}`;
      this.lastFailureAt = this.clock.now();
      await this.scheduleRetry(message, `DLQ_${deadLetterErrorCode}`);
      this.metrics.increment('outbox_events_total', { outcome: 'dead_letter_failed' });
      this.logger.error('outbox.event.dead_letter_failed', {
        eventId: message.eventId,
        eventType: message.eventType,
        publisherName: this.claimToken,
        errorCode: deadLetterErrorCode,
      });
    }
  }

  private async scheduleRetry(message: OutboxMessage, errorCode: string): Promise<void> {
    const delaySeconds = this.config.retryBackoffSeconds[
      Math.min(message.attempts, this.config.retryBackoffSeconds.length - 1)
    ] ?? 300;
    const now = this.clock.now();
    const nextAttemptAt = new Date(now.getTime() + delaySeconds * 1000);
    const scheduled = await this.repository.scheduleRetry(
      message.eventId,
      this.claimToken,
      now,
      nextAttemptAt,
      errorCode,
    );
    this.metrics.increment('outbox_events_total', { outcome: scheduled ? 'retry_scheduled' : 'claim_lost' });
    if (scheduled) {
      this.metrics.increment('wager_retries_total', { source: 'OUTBOX', reason: errorCode });
    }
  }

  private async recordLag(now: Date): Promise<void> {
    const lag = await this.repository.getLag(now);
    this.lastPendingCount = lag.pendingCount;
    this.lastLagSeconds = lag.oldestPendingAt
      ? Math.max(0, Math.floor((now.getTime() - lag.oldestPendingAt.getTime()) / 1000))
      : 0;
    this.metrics.set?.('outbox_pending_snapshot', lag.pendingCount);
    if (lag.oldestPendingAt) {
      this.metrics.set?.(
        'outbox_lag_seconds',
        this.lastLagSeconds,
      );
    }
  }

  private async pollLoop(): Promise<void> {
    while (!this.stopping) {
      try {
        await this.publishNextBatch();
      } catch (error) {
        this.lastFailureCode = failureCode(error);
        this.lastFailureAt = this.clock.now();
        this.metrics.increment('outbox_events_total', { outcome: 'worker_failed' });
        this.logger.error('outbox.worker.failed', { errorCode: failureCode(error) });
      }
      if (!this.stopping) await delay(this.config.pollIntervalMs);
    }
  }

  private eventId(message: OutboxMessage): string {
    return message.eventId;
  }
}

function failureCode(error: unknown): string {
  if (error instanceof Error && error.name && error.name !== 'Error') return error.name.slice(0, 100);
  if (error instanceof Error && error.message) return error.message.slice(0, 100).replaceAll(/\s+/g, '_').toUpperCase();
  return 'OUTBOX_PUBLISH_FAILED';
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

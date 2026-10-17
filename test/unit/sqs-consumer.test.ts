import { describe, expect, test } from 'bun:test';

import type { Clock } from '../../src/shared/application/ports/clock.port';
import type { AppLogger } from '../../src/shared/application/ports/logger.port';
import type { Metrics } from '../../src/shared/application/ports/metrics.port';
import { AsyncLocalCorrelationContext } from '../../src/shared/infrastructure/correlation/async-local-correlation-context';
import type { UnitOfWork } from '../../src/shared/application/ports/unit-of-work.port';
import { CanonicalPayloadHasher } from '../../src/modules/wagering/application/canonical-payload-hasher';
import type { ProcessWagerTransactionResult } from '../../src/modules/wagering/application/process-wager-transaction.use-case';
import type { InboxRepository } from '../../src/modules/messaging/inbox/application/ports/inbox-repository.port';
import type {
  ClaimInboxMessageInput,
  InboxClaimDecision,
  InboxClaimRepository,
} from '../../src/modules/messaging/inbox/application/ports/inbox-claim.port';
import { InboxMessage } from '../../src/modules/messaging/inbox/domain/inbox-message';
import type { MessageConsumer, ReceivedMessage } from '../../src/modules/messaging/sqs/application/ports/message-consumer.port';
import type { SqsConfig } from '../../src/modules/messaging/sqs/application/ports/sqs-config.port';
import { SqsWagerTransactionConsumer } from '../../src/modules/messaging/sqs/application/sqs-wager-transaction.consumer';
import { InMemoryMetrics } from '../../src/shared/infrastructure/metrics/in-memory-metrics';

const messageBody = JSON.stringify({
  messageId: 'message-1',
  type: 'WagerTransactionRequested',
  occurredAt: '2026-10-16T10:00:00.000Z',
  data: {
    providerId: 'provider-a',
    externalTransactionId: 'external-a',
    idempotencyKey: 'provider-a:external-a',
    playerId: 'player-a',
    walletId: 'wallet-a',
    roundId: 'round-a',
    gameId: 'game-a',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
  },
});

class InMemoryInboxRepository implements InboxClaimRepository {
  readonly messages = new Map<string, InboxMessage>();

  async find(consumerName: string, messageId: string): Promise<InboxMessage | null> {
    return this.messages.get(`${consumerName}:${messageId}`) ?? null;
  }

  async save(message: InboxMessage): Promise<void> {
    this.messages.set(`${message.consumerName}:${message.messageId}`, message);
  }

  async update(message: InboxMessage): Promise<void> {
    await this.save(message);
  }

  async claim(input: ClaimInboxMessageInput): Promise<InboxClaimDecision> {
    const key = `${input.consumerName}:${input.messageId}`;
    const existing = this.messages.get(key);
    if (!existing) {
      const created = InboxMessage.receive({
        consumerName: input.consumerName,
        messageId: input.messageId,
        payloadHash: input.payloadHash,
        receivedAt: input.now,
      });
      created.claim(input.claimedBy, input.now, input.leaseDurationMs);
      this.messages.set(key, created);
      return claimed(created);
    }
    if (!existing.hasPayloadHash(input.payloadHash)) return { kind: 'PAYLOAD_CONFLICT' };
    if (existing.status === 'PROCESSED') {
      return { kind: 'PROCESSED', processedAt: existing.processedAt! };
    }
    if (existing.status === 'FAILED_PERMANENT') {
      return { kind: 'FAILED_PERMANENT', errorCode: existing.lastErrorCode ?? 'PERMANENT_FAILURE' };
    }
    if (existing.leaseUntil && existing.leaseUntil > input.now && existing.claimedBy !== input.claimedBy) {
      return { kind: 'IN_FLIGHT', leaseUntil: existing.leaseUntil, claimedBy: existing.claimedBy };
    }
    existing.claim(input.claimedBy, input.now, input.leaseDurationMs);
    return claimed(existing);
  }

  async renewLease(input: {
    consumerName: string;
    messageId: string;
    claimedBy: string;
    now: Date;
    leaseDurationMs: number;
  }): Promise<boolean> {
    const message = this.messages.get(`${input.consumerName}:${input.messageId}`);
    if (!message) return false;
    try {
      message.renewLease(input.claimedBy, input.now, input.leaseDurationMs);
      return true;
    } catch {
      return false;
    }
  }

  async releaseLease(input: {
    consumerName: string;
    messageId: string;
    claimedBy: string;
    now: Date;
  }): Promise<boolean> {
    const message = this.messages.get(`${input.consumerName}:${input.messageId}`);
    if (!message) return false;
    try {
      message.releaseLease(input.claimedBy);
      return true;
    } catch {
      return false;
    }
  }
}

function claimed(message: InboxMessage): InboxClaimDecision {
  if (!message.processingStartedAt || !message.claimedBy || !message.leaseUntil) {
    throw new Error('claimed test message is missing lease metadata');
  }
  return {
    kind: 'CLAIMED',
    inbox: {
      consumerName: message.consumerName,
      messageId: message.messageId,
      payloadHash: message.payloadHash,
      status: 'PROCESSING',
      attempts: message.attempts,
      receivedAt: message.receivedAt,
      processingStartedAt: message.processingStartedAt,
      claimedBy: message.claimedBy,
      leaseUntil: message.leaseUntil,
    },
  };
}

class FakeConsumer implements MessageConsumer {
  deleted = 0;
  visibility: number[] = [];

  async receive(): Promise<ReceivedMessage[]> { return []; }
  async delete(): Promise<void> { this.deleted += 1; }
  async changeVisibility(_message: ReceivedMessage, seconds: number): Promise<void> {
    this.visibility.push(seconds);
  }
}

const clock: Clock = { now: () => new Date('2026-10-16T10:00:00.000Z') };
const logger: AppLogger = { info() {}, warn() {}, error() {} };
const metrics: Metrics = { increment() {} };
const correlationContext = new AsyncLocalCorrelationContext();
const unitOfWork: UnitOfWork = { execute: async <T>(work: () => Promise<T>) => work() };
const config: SqsConfig = {
  enabled: false,
  region: 'us-east-1',
  endpoint: 'http://localhost:4566',
  queueUrl: 'http://localhost:4566/000000000000/wager-transactions.fifo',
  dlqUrl: 'http://localhost:4566/000000000000/wager-transactions-dlq.fifo',
  consumerName: 'wager-transaction-consumer-v1',
  waitTimeSeconds: 0,
  maxNumberOfMessages: 10,
  visibilityTimeoutSeconds: 60,
  inboxLeaseSeconds: 120,
  instanceId: 'test-instance',
  retryBackoffSeconds: [30, 60, 120, 240, 300],
};

function receivedMessage(body: string = messageBody, receiveCount = 1): ReceivedMessage {
  return { body, receiptHandle: `receipt-${receiveCount}`, receiveCount };
}

function result(): ProcessWagerTransactionResult {
  return {
    transactionId: 'transaction-1',
    status: 'PROCESSED',
    balance: { amount: '75.00', currency: 'BRL' },
    idempotentReplay: false,
  };
}

describe('SqsWagerTransactionConsumer', () => {
  test('acks after processing and does not call the use case on replay', async () => {
    const transport = new FakeConsumer();
    const inbox = new InMemoryInboxRepository();
    let calls = 0;
    const useCase = { execute: async () => { calls += 1; return result(); } };
    const consumer = new SqsWagerTransactionConsumer(
      transport,
      inbox,
      useCase as never,
      unitOfWork,
      clock,
      correlationContext,
      new CanonicalPayloadHasher(),
      logger,
      metrics,
      config,
    );

    await consumer.processMessage(receivedMessage());
    await consumer.processMessage(receivedMessage());

    expect(calls).toBe(1);
    expect(transport.deleted).toBe(2);
    expect([...inbox.messages.values()][0]?.status).toBe('PROCESSED');
  });

  test('emits low-cardinality claim, replay, redelivery and lifecycle telemetry', async () => {
    const transport = new FakeConsumer();
    const inbox = new InMemoryInboxRepository();
    const metrics = new InMemoryMetrics();
    const consumer = new SqsWagerTransactionConsumer(
      transport,
      inbox,
      { execute: async () => result() } as never,
      unitOfWork,
      clock,
      correlationContext,
      new CanonicalPayloadHasher(),
      logger,
      metrics,
      config,
    );

    await consumer.processMessage(receivedMessage(messageBody, 1));
    await consumer.processMessage(receivedMessage(messageBody, 2));
    await consumer.onModuleDestroy();

    const snapshot = metrics.snapshot();
    expect(snapshot.get('sqs_inbox_claim_total{outcome=claimed}')).toBe(1);
    expect(snapshot.get('sqs_inbox_claim_total{outcome=processed}')).toBe(1);
    expect(snapshot.get('sqs_redeliveries_total{queue=input}')).toBe(1);
    expect(snapshot.get('sqs_messages_total{outcome=replay,queue=input}')).toBe(1);
    expect(snapshot.get('sqs_consumer_lifecycle_total{event=shutdown_requested}')).toBe(1);
    expect(snapshot.get('sqs_consumer_lifecycle_total{event=shutdown_completed}')).toBe(1);
  });

  test('does not ack a changed payload and sends it toward redrive', async () => {
    const transport = new FakeConsumer();
    const inbox = new InMemoryInboxRepository();
    let calls = 0;
    const useCase = { execute: async () => { calls += 1; return result(); } };
    const consumer = new SqsWagerTransactionConsumer(
      transport,
      inbox,
      useCase as never,
      unitOfWork,
      clock,
      correlationContext,
      new CanonicalPayloadHasher(),
      logger,
      metrics,
      config,
    );

    await consumer.processMessage(receivedMessage());
    const changed = JSON.stringify({
      ...JSON.parse(messageBody),
      data: { ...JSON.parse(messageBody).data, money: { amount: '30.00', currency: 'BRL' } },
    });
    const outcome = await consumer.processMessage(receivedMessage(changed, 2));

    expect(outcome.action).toBe('RETRY');
    expect(transport.deleted).toBe(1);
    expect(transport.visibility).toEqual([0]);
    expect(calls).toBe(1);
  });

  test('uses the approved transient backoff without acknowledging', async () => {
    const transport = new FakeConsumer();
    const inbox = new InMemoryInboxRepository();
    const useCase = { execute: async () => { throw new Error('database temporarily unavailable'); } };
    const consumer = new SqsWagerTransactionConsumer(
      transport,
      inbox,
      useCase as never,
      unitOfWork,
      clock,
      correlationContext,
      new CanonicalPayloadHasher(),
      logger,
      metrics,
      config,
    );

    const outcome = await consumer.processMessage(receivedMessage(messageBody, 3));

    expect(outcome.classification).toBe('TRANSIENT');
    expect(transport.deleted).toBe(0);
    expect(transport.visibility).toEqual([120]);
    expect([...inbox.messages.values()][0]?.status).toBe('FAILED_RETRYABLE');
  });

  test('classifies invalid envelopes with a stable metric and no business call', async () => {
    const transport = new FakeConsumer();
    const inbox = new InMemoryInboxRepository();
    const metrics = new InMemoryMetrics();
    let calls = 0;
    const useCase = { execute: async () => { calls += 1; return result(); } };
    const consumer = new SqsWagerTransactionConsumer(
      transport,
      inbox,
      useCase as never,
      unitOfWork,
      clock,
      correlationContext,
      new CanonicalPayloadHasher(),
      logger,
      metrics,
      config,
    );

    const outcome = await consumer.processMessage(receivedMessage(JSON.stringify({ messageId: 'invalid-envelope' })));

    expect(outcome).toEqual({ action: 'RETRY', classification: 'PERMANENT' });
    expect(calls).toBe(0);
    expect(transport.visibility).toEqual([0]);
    expect([...inbox.messages.values()][0]?.status).toBe('FAILED_PERMANENT');
    expect(metrics.snapshot().get('sqs_messages_total{outcome=invalid_envelope,queue=input}')).toBe(1);
    expect(metrics.snapshot().get('sqs_dlq_messages_total{queue=input,reason=invalid_envelope}')).toBe(1);
    expect(metrics.observationsSnapshot().get('processing_duration_ms{operation=SQS_CONSUME,source=SQS}')?.length).toBe(1);
  });

  test('does not start new messages during shutdown and waits for in-flight work', async () => {
    const transport = new FakeConsumer();
    const inbox = new InMemoryInboxRepository();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const useCase = {
      execute: async () => {
        await blocked;
        return result();
      },
    };
    const consumer = new SqsWagerTransactionConsumer(
      transport,
      inbox,
      useCase as never,
      unitOfWork,
      clock,
      correlationContext,
      new CanonicalPayloadHasher(),
      logger,
      metrics,
      config,
    );

    const inFlight = consumer.processMessage(receivedMessage(messageBody, 1));
    await Promise.resolve();
    const shutdown = consumer.onModuleDestroy();
    const rejectedDuringDrain = await consumer.processMessage(receivedMessage(messageBody, 2));

    expect(rejectedDuringDrain).toEqual({ action: 'RETRY', classification: 'TRANSIENT' });
    expect(transport.visibility).toEqual([0]);
    release();
    await inFlight;
    await shutdown;
    expect(transport.deleted).toBe(1);
  });
});

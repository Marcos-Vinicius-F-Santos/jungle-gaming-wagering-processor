import { describe, expect, test } from 'bun:test';
import { v7 } from 'uuid';

import { OutboxMessage } from '../../src/modules/messaging/outbox/domain/outbox-message';

describe('OutboxMessage', () => {
  test('creates a pending versioned event with no publication attempts', () => {
    const occurredAt = new Date('2026-10-15T20:00:00.000Z');
    const message = OutboxMessage.enqueue({
      eventId: v7(),
      aggregateId: v7(),
      correlationId: 'correlation-a',
      eventType: 'WagerTransactionProcessed',
      version: 1,
      data: { transactionId: 'transaction-a' },
      occurredAt,
    });

    expect(message.attempts).toBe(0);
    expect(message.nextAttemptAt).toEqual(occurredAt);
    expect(message.publishedAt).toBeUndefined();
    expect(message.eventType).toBe('WagerTransactionProcessed');
    expect(message.toJSON()).toMatchObject({
      correlationId: 'correlation-a',
      data: { transactionId: 'transaction-a' },
    });
  });

  test('rehydrates, claims, retries and marks intervention without changing the envelope', () => {
    const occurredAt = new Date('2026-10-15T20:00:00.000Z');
    const message = OutboxMessage.rehydrate({
      eventId: v7(),
      aggregateId: v7(),
      correlationId: 'correlation-a',
      eventType: 'WalletBalanceChanged',
      version: 1,
      data: { amount: '10.00', currency: 'BRL' },
      occurredAt,
      attempts: 0,
      nextAttemptAt: occurredAt,
    });
    const envelope = message.toJSON();

    message.claim('publisher-1', new Date('2026-10-15T20:00:30.000Z'));
    expect(message.isDue(new Date('2026-10-15T20:00:01.000Z'))).toBe(false);
    message.scheduleRetry(new Date('2026-10-15T20:00:01.000Z'), [30, 60], 'BROKER_TIMEOUT');

    expect(message.attempts).toBe(1);
    expect(message.nextAttemptAt).toEqual(new Date('2026-10-15T20:00:31.000Z'));
    expect(message.toJSON()).toEqual(envelope);

    message.claim('publisher-1', new Date('2026-10-15T20:01:31.000Z'));
    message.markIntervention(new Date('2026-10-15T20:01:01.000Z'), 'DLQ_CONFIRMED');
    expect(message.interventionRequired).toBe(true);
    expect(message.isDue(new Date('2026-10-15T21:00:00.000Z'))).toBe(false);
  });

  test('marks publication and clears the claim', () => {
    const message = OutboxMessage.enqueue({
      eventId: v7(),
      aggregateId: v7(),
      correlationId: 'correlation-a',
      eventType: 'WagerTransactionProcessed',
      version: 1,
      data: { transactionId: 'transaction-a' },
      occurredAt: new Date('2026-10-15T20:00:00.000Z'),
    });
    message.claim('publisher-1', new Date('2026-10-15T20:01:00.000Z'));
    message.markPublished(new Date('2026-10-15T20:00:05.000Z'));

    expect(message.publishedAt).toEqual(new Date('2026-10-15T20:00:05.000Z'));
    expect(message.claimedBy).toBeUndefined();
  });
});

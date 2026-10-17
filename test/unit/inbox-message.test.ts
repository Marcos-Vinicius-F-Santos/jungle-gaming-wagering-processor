import { describe, expect, test } from 'bun:test';

import { InboxMessage } from '../../src/modules/messaging/inbox/domain/inbox-message';

describe('InboxMessage', () => {
  test('tracks processing, retryable failure and successful commit', () => {
    const receivedAt = new Date('2026-10-16T10:00:00.000Z');
    const message = InboxMessage.receive({
      consumerName: 'wager-transaction-consumer-v1',
      messageId: 'message-1',
      payloadHash: 'a'.repeat(64),
      receivedAt,
    });

    expect(message.status).toBe('PROCESSING');
    expect(message.attempts).toBe(1);
    message.markRetryable('DATABASE_UNAVAILABLE', new Date('2026-10-16T10:00:01.000Z'));
    expect(message.status).toBe('FAILED_RETRYABLE');
    message.startProcessing(new Date('2026-10-16T10:01:00.000Z'));
    expect(message.attempts).toBe(2);
    message.markProcessed(new Date('2026-10-16T10:01:01.000Z'));
    expect(message.status).toBe('PROCESSED');
    expect(message.processedAt?.toISOString()).toBe('2026-10-16T10:01:01.000Z');
  });

  test('does not mark permanent diagnostics as a successful processing', () => {
    const message = InboxMessage.receive({
      consumerName: 'consumer',
      messageId: 'message-2',
      payloadHash: 'b'.repeat(64),
      receivedAt: new Date('2026-10-16T10:00:00.000Z'),
    });

    message.markPermanent('PAYLOAD_CONFLICT', new Date('2026-10-16T10:00:01.000Z'));
    expect(message.status).toBe('FAILED_PERMANENT');
    expect(message.processedAt).toBeUndefined();
    expect(() => message.startProcessing(new Date())).toThrow('permanently failed');
  });

  test('claims, renews and releases a processing lease', () => {
    const now = new Date('2026-10-16T10:00:00.000Z');
    const message = InboxMessage.receive({
      consumerName: 'consumer',
      messageId: 'message-3',
      payloadHash: 'c'.repeat(64),
      receivedAt: now,
    });

    message.claim('instance-1', now, 30_000);
    expect(message.claimedBy).toBe('instance-1');
    expect(message.leaseUntil?.toISOString()).toBe('2026-10-16T10:00:30.000Z');

    message.renewLease('instance-1', new Date('2026-10-16T10:00:10.000Z'), 30_000);
    expect(message.leaseUntil?.toISOString()).toBe('2026-10-16T10:00:40.000Z');

    message.releaseLease('instance-1');
    expect(message.claimedBy).toBeUndefined();
    expect(message.leaseUntil).toBeUndefined();
  });
});

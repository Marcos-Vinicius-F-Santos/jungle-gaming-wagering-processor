import { describe, expect, test } from 'bun:test';

import type {
  ClaimInboxMessageInput,
  InboxClaimDecision,
  InboxClaimRepository,
} from '../../src/modules/messaging/inbox/application/ports/inbox-claim.port';

describe('Inbox claim contract', () => {
  test('represents a claimed message with an explicit lease', () => {
    const now = new Date('2026-10-16T10:00:00.000Z');
    const decision: InboxClaimDecision = {
      kind: 'CLAIMED',
      inbox: {
        consumerName: 'wager-transaction-consumer-v1',
        messageId: 'message-1',
        payloadHash: 'a'.repeat(64),
        status: 'PROCESSING',
        attempts: 1,
        receivedAt: now,
        processingStartedAt: now,
        claimedBy: 'instance-1',
        leaseUntil: new Date('2026-10-16T10:00:30.000Z'),
      },
    };

    expect(decision.kind).toBe('CLAIMED');
    if (decision.kind === 'CLAIMED') {
      expect(decision.inbox.leaseUntil.getTime()).toBeGreaterThan(now.getTime());
      expect(decision.inbox.claimedBy).toBe('instance-1');
    }
  });

  test('keeps replay, active lease and payload conflict explicit', () => {
    const processed: InboxClaimDecision = {
      kind: 'PROCESSED',
      processedAt: new Date('2026-10-16T10:01:00.000Z'),
    };
    const inFlight: InboxClaimDecision = {
      kind: 'IN_FLIGHT',
      leaseUntil: new Date('2026-10-16T10:01:30.000Z'),
      claimedBy: 'instance-2',
    };
    const conflict: InboxClaimDecision = { kind: 'PAYLOAD_CONFLICT' };

    expect([processed.kind, inFlight.kind, conflict.kind]).toEqual([
      'PROCESSED',
      'IN_FLIGHT',
      'PAYLOAD_CONFLICT',
    ]);
  });

  test('keeps claim operations behind an application port', () => {
    const input: ClaimInboxMessageInput = {
      consumerName: 'wager-transaction-consumer-v1',
      messageId: 'message-1',
      payloadHash: 'a'.repeat(64),
      claimedBy: 'instance-1',
      now: new Date('2026-10-16T10:00:00.000Z'),
      leaseDurationMs: 30_000,
    };
    const repository: InboxClaimRepository = {
      find: async () => null,
      save: async () => undefined,
      update: async () => undefined,
      claim: async () => ({
        kind: 'IN_FLIGHT',
        leaseUntil: input.now,
      }),
      renewLease: async () => true,
      releaseLease: async () => true,
    };

    expect(repository).toBeDefined();
    expect(input.leaseDurationMs).toBe(30_000);
  });
});

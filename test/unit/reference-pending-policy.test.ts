import { describe, expect, test } from 'bun:test';

import {
  REFERENCE_PENDING_TTL_MS,
  ReferencePendingPolicy,
} from '../../src/modules/wagering/application/reference-pending-policy';

describe('ReferencePendingPolicy', () => {
  const policy = new ReferencePendingPolicy();
  const start = new Date('2026-10-15T20:00:00.000Z');

  test('uses the approved initial backoff and keeps the first pending timestamp', () => {
    const schedule = policy.scheduleInitial(start);

    expect(schedule.attempt).toBe(0);
    expect(schedule.pendingSince).toEqual(start);
    expect(schedule.nextAttemptAt).toEqual(new Date('2026-10-15T20:00:30.000Z'));
  });

  test('uses 30s, 1m, 2m, 4m and 7m without scheduling beyond the TTL', () => {
    const expectedDelays = [30_000, 60_000, 120_000, 240_000, 420_000];
    let pendingSince = start;
    let now = start;

    expectedDelays.forEach((delay, index) => {
      const schedule = policy.scheduleRetry(pendingSince, index, now);
      expect(schedule?.nextAttemptAt.getTime()).toBe(now.getTime() + delay);
      expect(schedule?.attempt).toBe(index + 1);
      pendingSince = schedule!.pendingSince;
      now = schedule!.nextAttemptAt;
    });

    expect(policy.scheduleRetry(pendingSince, expectedDelays.length, now)).toBeNull();
    expect(policy.isExpired(start, new Date(start.getTime() + REFERENCE_PENDING_TTL_MS))).toBe(true);
  });
});

const RETRY_DELAYS_MS = [30_000, 60_000, 120_000, 240_000, 420_000] as const;

export const REFERENCE_PENDING_TTL_MS = 15 * 60_000;

export interface ReferencePendingSchedule {
  pendingSince: Date;
  nextAttemptAt: Date;
  attempt: number;
}

export class ReferencePendingPolicy {
  scheduleInitial(now: Date): ReferencePendingSchedule {
    assertValidDate(now);
    return {
      pendingSince: new Date(now.getTime()),
      nextAttemptAt: new Date(now.getTime() + RETRY_DELAYS_MS[0]),
      attempt: 0,
    };
  }

  scheduleRetry(pendingSince: Date, attempts: number, now: Date): ReferencePendingSchedule | null {
    assertValidDate(pendingSince);
    assertValidDate(now);
    if (!Number.isInteger(attempts) || attempts < 0) {
      throw new Error('pending attempts must be a non-negative integer');
    }
    if (this.isExpired(pendingSince, now) || attempts >= RETRY_DELAYS_MS.length) {
      return null;
    }

    const nextAttemptAt = new Date(now.getTime() + RETRY_DELAYS_MS[attempts]);
    if (nextAttemptAt.getTime() > pendingSince.getTime() + REFERENCE_PENDING_TTL_MS) {
      return null;
    }

    return {
      pendingSince: new Date(pendingSince.getTime()),
      nextAttemptAt,
      attempt: attempts + 1,
    };
  }

  isExpired(pendingSince: Date, now: Date): boolean {
    assertValidDate(pendingSince);
    assertValidDate(now);
    return now.getTime() >= pendingSince.getTime() + REFERENCE_PENDING_TTL_MS;
  }
}

function assertValidDate(value: Date): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error('reference pending timestamp must be a valid date');
  }
}

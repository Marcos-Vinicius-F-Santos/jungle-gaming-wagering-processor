import type { OutboxMessage } from '../../domain/outbox-message';

export interface OutboxClaimOptions {
  now: Date;
  limit: number;
  publisherName: string;
  leaseUntil: Date;
}

export interface OutboxLagSnapshot {
  pendingCount: number;
  oldestPendingAt?: Date;
}

export interface OutboxRepository {
  enqueue(message: OutboxMessage): Promise<void>;
  claimDue(options: OutboxClaimOptions): Promise<OutboxMessage[]>;
  markPublished(eventId: string, publisherName: string, publishedAt: Date): Promise<boolean>;
  scheduleRetry(
    eventId: string,
    publisherName: string,
    now: Date,
    nextAttemptAt: Date,
    errorCode: string,
  ): Promise<boolean>;
  markIntervention(
    eventId: string,
    publisherName: string,
    deadLetteredAt: Date,
    errorCode: string,
  ): Promise<boolean>;
  getLag(now: Date): Promise<OutboxLagSnapshot>;
}

export const OUTBOX_REPOSITORY = Symbol('OUTBOX_REPOSITORY');

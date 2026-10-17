import { EntityManager, LockMode } from '@mikro-orm/postgresql';
import { raw } from '@mikro-orm/core';
import { Injectable } from '@nestjs/common';

import type {
  OutboxClaimOptions,
  OutboxLagSnapshot,
  OutboxRepository,
} from '../../application/ports/outbox-repository.port';
import { OutboxMessage } from '../../domain/outbox-message';
import { OutboxMessageEntity } from './entities/outbox-message.entity';

@Injectable()
export class MikroOrmOutboxRepository implements OutboxRepository {
  constructor(private readonly entityManager: EntityManager) {}

  async enqueue(message: OutboxMessage): Promise<void> {
    const entity = this.entityManager.create(OutboxMessageEntity, {
      eventId: message.eventId,
      aggregateId: message.aggregateId,
      eventType: message.eventType,
      version: message.version,
      payload: message.toJSON(),
      attempts: message.attempts,
      nextAttemptAt: message.nextAttemptAt,
      occurredAt: message.occurredAt,
      publishedAt: message.publishedAt,
      createdAt: message.occurredAt,
      claimedBy: message.claimedBy,
      claimedUntil: message.claimedUntil,
      lastErrorCode: message.lastErrorCode,
      lastErrorAt: message.lastErrorAt,
      interventionRequired: message.interventionRequired,
      deadLetteredAt: message.deadLetteredAt,
    });
    this.entityManager.persist(entity);
    await this.entityManager.flush();
  }

  async claimDue(options: OutboxClaimOptions): Promise<OutboxMessage[]> {
    const entities = await this.entityManager.getRepository(OutboxMessageEntity).find(
      {
        publishedAt: null,
        interventionRequired: false,
        nextAttemptAt: { $lte: options.now },
        $or: [
          { claimedUntil: null },
          { claimedUntil: { $lte: options.now } },
        ],
      },
      {
        limit: options.limit,
        orderBy: { nextAttemptAt: 'asc', eventId: 'asc' },
        lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE,
      },
    );

    const claimed: OutboxMessage[] = [];
    for (const entity of entities) {
      entity.claimedBy = options.publisherName;
      entity.claimedUntil = options.leaseUntil;
      claimed.push(this.toDomain(entity));
    }
    await this.entityManager.flush();
    return claimed;
  }

  async markPublished(eventId: string, publisherName: string, publishedAt: Date): Promise<boolean> {
    const result = await this.entityManager.nativeUpdate(
      OutboxMessageEntity,
      {
        eventId,
        publishedAt: null,
        $or: [
          { claimedBy: publisherName },
          { claimedUntil: { $lte: publishedAt } },
        ],
      },
      { publishedAt, claimedBy: null, claimedUntil: null },
    );
    return result > 0;
  }

  async scheduleRetry(
    eventId: string,
    publisherName: string,
    now: Date,
    nextAttemptAt: Date,
    errorCode: string,
  ): Promise<boolean> {
    const result = await this.entityManager.nativeUpdate(
      OutboxMessageEntity,
      { eventId, publishedAt: null, claimedBy: publisherName },
      {
        attempts: raw('attempts + 1'),
        nextAttemptAt,
        claimedBy: null,
        claimedUntil: null,
        lastErrorCode: errorCode.slice(0, 100),
        lastErrorAt: now,
      },
    );
    return result > 0;
  }

  async markIntervention(
    eventId: string,
    publisherName: string,
    deadLetteredAt: Date,
    errorCode: string,
  ): Promise<boolean> {
    const result = await this.entityManager.nativeUpdate(
      OutboxMessageEntity,
      { eventId, publishedAt: null, claimedBy: publisherName },
      {
        attempts: raw('attempts + 1'),
        interventionRequired: true,
        deadLetteredAt,
        lastErrorCode: errorCode.slice(0, 100),
        lastErrorAt: deadLetteredAt,
        claimedBy: null,
        claimedUntil: null,
      },
    );
    return result > 0;
  }

  async getLag(now: Date): Promise<OutboxLagSnapshot> {
    const rows = await this.entityManager.getConnection().execute<{
      pending_count: string;
      oldest_pending_at: Date | null;
    }[]>(
      `select count(*)::text as pending_count, min(coalesce(occurred_at, created_at)) as oldest_pending_at
       from outbox_messages
       where published_at is null and intervention_required = false`,
    );
    const row = rows[0];
    return {
      pendingCount: Number(row?.pending_count ?? 0),
      oldestPendingAt: row?.oldest_pending_at ? new Date(row.oldest_pending_at) : undefined,
    };
  }

  private toDomain(entity: OutboxMessageEntity): OutboxMessage {
    const payload = entity.payload;
    return OutboxMessage.rehydrate({
      eventId: entity.eventId,
      aggregateId: entity.aggregateId,
      correlationId: String(payload.correlationId ?? ''),
      causationId: typeof payload.causationId === 'string' ? payload.causationId : undefined,
      eventType: entity.eventType as OutboxMessage['eventType'],
      version: entity.version,
      data: (payload.data ?? {}) as Record<string, unknown>,
      occurredAt: new Date(entity.occurredAt),
      attempts: entity.attempts,
      nextAttemptAt: new Date(entity.nextAttemptAt),
      publishedAt: entity.publishedAt ? new Date(entity.publishedAt) : undefined,
      claimedBy: entity.claimedBy,
      claimedUntil: entity.claimedUntil ? new Date(entity.claimedUntil) : undefined,
      lastErrorCode: entity.lastErrorCode,
      lastErrorAt: entity.lastErrorAt ? new Date(entity.lastErrorAt) : undefined,
      interventionRequired: entity.interventionRequired,
      deadLetteredAt: entity.deadLetteredAt ? new Date(entity.deadLetteredAt) : undefined,
    });
  }
}

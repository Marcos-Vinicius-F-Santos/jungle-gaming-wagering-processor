import { EntityManager } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';

import type { InboxRepository } from '../../application/ports/inbox-repository.port';
import type {
  ClaimInboxMessageInput,
  InboxClaimDecision,
  InboxClaimRepository,
} from '../../application/ports/inbox-claim.port';
import { InboxMessage } from '../../domain/inbox-message';
import { InboxMessageEntity } from './entities/inbox-message.entity';

@Injectable()
export class MikroOrmInboxRepository implements InboxRepository, InboxClaimRepository {
  constructor(private readonly entityManager: EntityManager) {}

  async find(consumerName: string, messageId: string): Promise<InboxMessage | null> {
    const entity = await this.entityManager.findOne(InboxMessageEntity, { consumerName, messageId });
    return entity ? this.toDomain(entity) : null;
  }

  async save(message: InboxMessage): Promise<void> {
    const state = message.toState();
    this.entityManager.persist(this.toEntity(state));
    await this.entityManager.flush();
  }

  async update(message: InboxMessage): Promise<void> {
    const state = message.toState();
    const entity = await this.entityManager.findOneOrFail(InboxMessageEntity, {
      consumerName: state.consumerName,
      messageId: state.messageId,
    });
    entity.payloadHash = state.payloadHash;
    entity.receivedAt = state.receivedAt;
    entity.status = state.status;
    entity.attempts = state.attempts;
    entity.processedAt = state.processedAt;
    entity.lastErrorCode = state.lastErrorCode;
    entity.lastErrorAt = state.lastErrorAt;
    entity.claimedBy = state.claimedBy;
    entity.leaseUntil = state.leaseUntil;
    entity.processingStartedAt = state.processingStartedAt;
    await this.entityManager.flush();
  }

  async claim(input: ClaimInboxMessageInput): Promise<InboxClaimDecision> {
    assertClaimInput(input);
    return this.entityManager.transactional(async (manager) => {
      const inserted = await this.execute<InboxRow>(manager, `
        insert into inbox_messages (
          consumer_name,
          message_id,
          payload_hash,
          received_at,
          status,
          attempts,
          processing_started_at,
          claimed_by,
          lease_until
        ) values (?, ?, ?, ?, 'PROCESSING', 1, ?, ?, ?)
        on conflict (consumer_name, message_id) do nothing
        returning *
      `, [
        input.consumerName,
        input.messageId,
        input.payloadHash,
        input.now,
        input.now,
        input.claimedBy,
        leaseUntil(input.now, input.leaseDurationMs),
      ]);
      if (inserted.length > 0) return toClaimedDecision(inserted[0]);

      const existing = await this.execute<InboxRow>(manager, `
        select *
        from inbox_messages
        where consumer_name = ? and message_id = ?
        for update
      `, [input.consumerName, input.messageId]);
      if (existing.length === 0) {
        throw new Error('Inbox claim lost the message row after conflict resolution');
      }

      const row = existing[0];
      if (row.payload_hash !== input.payloadHash) return { kind: 'PAYLOAD_CONFLICT' };
      if (row.status === 'PROCESSED') {
        if (!row.processed_at) throw new Error('Processed Inbox row is missing processed_at');
        return { kind: 'PROCESSED', processedAt: toDate(row.processed_at) };
      }
      if (row.status === 'FAILED_PERMANENT') {
        return { kind: 'FAILED_PERMANENT', errorCode: row.last_error_code ?? 'PERMANENT_FAILURE' };
      }
      const currentLeaseUntil = row.lease_until ? toDate(row.lease_until) : undefined;
      if (currentLeaseUntil && currentLeaseUntil.getTime() > input.now.getTime() && row.claimed_by !== input.claimedBy) {
        return { kind: 'IN_FLIGHT', leaseUntil: currentLeaseUntil, claimedBy: row.claimed_by ?? undefined };
      }

      const reclaimed = await this.execute<InboxRow>(manager, `
        update inbox_messages
        set status = 'PROCESSING',
            attempts = attempts + 1,
            processing_started_at = ?,
            claimed_by = ?,
            lease_until = ?,
            processed_at = null,
            last_error_code = null,
            last_error_at = null
        where consumer_name = ? and message_id = ?
        returning *
      `, [
        input.now,
        input.claimedBy,
        leaseUntil(input.now, input.leaseDurationMs),
        input.consumerName,
        input.messageId,
      ]);
      return toClaimedDecision(reclaimed[0]);
    });
  }

  async renewLease(input: {
    consumerName: string;
    messageId: string;
    claimedBy: string;
    now: Date;
    leaseDurationMs: number;
  }): Promise<boolean> {
    assertLeaseInput(input);
    const rows = await this.execute<InboxRow>(this.entityManager, `
      update inbox_messages
      set lease_until = ?
      where consumer_name = ?
        and message_id = ?
        and status = 'PROCESSING'
        and claimed_by = ?
        and lease_until > ?
      returning message_id
    `, [
      leaseUntil(input.now, input.leaseDurationMs),
      input.consumerName,
      input.messageId,
      input.claimedBy,
      input.now,
    ]);
    return rows.length > 0;
  }

  async releaseLease(input: {
    consumerName: string;
    messageId: string;
    claimedBy: string;
    now: Date;
  }): Promise<boolean> {
    if (!input.claimedBy.trim()) throw new Error('Inbox claimedBy must not be empty');
    const rows = await this.execute<InboxRow>(this.entityManager, `
      update inbox_messages
      set claimed_by = null,
          lease_until = null
      where consumer_name = ?
        and message_id = ?
        and status = 'PROCESSING'
        and claimed_by = ?
      returning message_id
    `, [input.consumerName, input.messageId, input.claimedBy]);
    return rows.length > 0;
  }

  private toEntity(state: ReturnType<InboxMessage['toState']>): InboxMessageEntity {
    return this.entityManager.create(InboxMessageEntity, {
      consumerName: state.consumerName,
      messageId: state.messageId,
      payloadHash: state.payloadHash,
      receivedAt: state.receivedAt,
      status: state.status,
      attempts: state.attempts,
      processedAt: state.processedAt,
      lastErrorCode: state.lastErrorCode,
      lastErrorAt: state.lastErrorAt,
      claimedBy: state.claimedBy,
      leaseUntil: state.leaseUntil,
      processingStartedAt: state.processingStartedAt,
    });
  }

  private async execute<T>(manager: EntityManager, query: string, params: unknown[]): Promise<T[]> {
    const result = await manager.getConnection().execute(query, params, 'all', manager.getTransactionContext());
    return result as T[];
  }

  private toDomain(entity: InboxMessageEntity): InboxMessage {
    return InboxMessage.rehydrate({
      consumerName: entity.consumerName,
      messageId: entity.messageId,
      payloadHash: entity.payloadHash,
      receivedAt: entity.receivedAt,
      status: entity.status,
      attempts: entity.attempts,
      processedAt: entity.processedAt,
      lastErrorCode: entity.lastErrorCode,
      lastErrorAt: entity.lastErrorAt,
      claimedBy: entity.claimedBy,
      leaseUntil: entity.leaseUntil,
      processingStartedAt: entity.processingStartedAt,
    });
  }
}

interface InboxRow {
  consumer_name: string;
  message_id: string;
  payload_hash: string;
  received_at: Timestamp;
  status: 'PROCESSING' | 'PROCESSED' | 'FAILED_RETRYABLE' | 'FAILED_PERMANENT';
  attempts: number;
  processed_at: Timestamp | null;
  last_error_code: string | null;
  last_error_at: Timestamp | null;
  claimed_by: string | null;
  lease_until: Timestamp | null;
  processing_started_at: Timestamp | null;
}

type Timestamp = Date | string;

function toClaimedDecision(row: InboxRow): InboxClaimDecision {
  if (!row.processing_started_at || !row.claimed_by || !row.lease_until) {
    throw new Error('Claimed Inbox row is missing lease metadata');
  }
  return {
    kind: 'CLAIMED',
    inbox: {
      consumerName: row.consumer_name,
      messageId: row.message_id,
      payloadHash: row.payload_hash,
      status: 'PROCESSING',
      attempts: row.attempts,
      receivedAt: toDate(row.received_at),
      processingStartedAt: toDate(row.processing_started_at),
      claimedBy: row.claimed_by,
      leaseUntil: toDate(row.lease_until),
    },
  };
}

function toDate(value: Timestamp): Date {
  return value instanceof Date ? value : new Date(value);
}

function leaseUntil(now: Date, durationMs: number): Date {
  return new Date(now.getTime() + durationMs);
}

function assertClaimInput(input: ClaimInboxMessageInput): void {
  if (!input.consumerName.trim() || !input.messageId.trim() || !input.payloadHash.trim() || !input.claimedBy.trim()) {
    throw new Error('Inbox claim identifiers must not be empty');
  }
  if (!Number.isInteger(input.leaseDurationMs) || input.leaseDurationMs <= 0) {
    throw new Error('Inbox lease duration must be a positive integer');
  }
}

function assertLeaseInput(input: {
  consumerName: string;
  messageId: string;
  claimedBy: string;
  leaseDurationMs: number;
}): void {
  if (!input.consumerName.trim() || !input.messageId.trim() || !input.claimedBy.trim()) {
    throw new Error('Inbox lease identifiers must not be empty');
  }
  if (!Number.isInteger(input.leaseDurationMs) || input.leaseDurationMs <= 0) {
    throw new Error('Inbox lease duration must be a positive integer');
  }
}

import { LockMode } from '@mikro-orm/core';
import { EntityManager } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';

import { WagerTransaction } from '../../domain/wager-transaction';
import type {
  WagerTransactionRecord,
  WagerTransactionRepository,
} from '../../application/ports/wager-transaction-repository.port';
import { Money } from '../../../../shared/domain/money';
import { WagerTransactionEntity } from './entities/wager-transaction.entity';

@Injectable()
export class MikroOrmWagerTransactionRepository implements WagerTransactionRepository<WagerTransaction> {
  constructor(private readonly entityManager: EntityManager) {}

  async save(transaction: WagerTransaction): Promise<void> {
    const entity = this.entityManager.create(WagerTransactionEntity, {
      id: transaction.id,
      providerId: transaction.providerId,
      externalTransactionId: transaction.externalTransactionId,
      walletId: transaction.walletId,
      playerId: transaction.playerId,
      idempotencyKey: transaction.idempotencyKey,
      payloadHash: transaction.payloadHash,
      roundId: transaction.roundId,
      gameId: transaction.gameId,
      referenceExternalTransactionId: transaction.referenceExternalTransactionId,
      referenceTransactionId: transaction.referenceTransactionId,
      pendingSince: transaction.pendingSince,
      nextAttemptAt: transaction.nextAttemptAt,
      pendingAttempts: transaction.pendingAttempts,
      kind: transaction.kind,
      amount: transaction.amount.amount,
      currency: transaction.amount.currency,
      status: transaction.status,
      failureCode: transaction.failureCode,
      resultBalanceAmount: transaction.resultBalance?.amount,
      resultBalanceCurrency: transaction.resultBalance?.currency,
      createdAt: transaction.createdAt,
      processedAt: transaction.processedAt,
    });
    this.entityManager.persist(entity);
    await this.entityManager.flush();
  }

  async findById(transactionId: string): Promise<WagerTransaction | null> {
    const entity = await this.readManager().findOne(WagerTransactionEntity, { id: transactionId });
    if (!entity || entity.kind !== 'OPENING' || entity.status !== 'PROCESSED' || !entity.processedAt) {
      return null;
    }

    return WagerTransaction.opening(
      entity.id,
      entity.walletId,
      entity.playerId,
      Money.of(entity.amount, entity.currency),
      entity.createdAt,
    );
  }

  async findByIdempotencyKey(
    providerId: string,
    idempotencyKey: string,
  ): Promise<WagerTransactionRecord | null> {
    const entity = await this.readManager().findOne(WagerTransactionEntity, {
      providerId,
      idempotencyKey,
    });
    return entity ? this.toRecord(entity) : null;
  }

  async findByExternalTransactionId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransactionRecord | null> {
    const entity = await this.readManager().findOne(WagerTransactionEntity, {
      providerId,
      externalTransactionId,
    });
    return entity ? this.toRecord(entity) : null;
  }

  async findDirectReversal(referenceTransactionId: string): Promise<WagerTransactionRecord | null> {
    const entity = await this.readManager().findOne(WagerTransactionEntity, {
      referenceTransactionId,
      kind: { $in: ['REFUND', 'ROLLBACK'] },
    });
    return entity ? this.toRecord(entity) : null;
  }

  async findPendingReferenceDue(now: Date, limit: number): Promise<WagerTransactionRecord[]> {
    const entities = await this.readManager().find(
      WagerTransactionEntity,
      { status: 'PENDING_REFERENCE', nextAttemptAt: { $lte: now } },
      { orderBy: { nextAttemptAt: 'asc', id: 'asc' }, limit },
    );
    return entities.map((entity) => this.toRecord(entity));
  }

  async findPendingReferenceDueForUpdate(now: Date, limit: number): Promise<WagerTransactionRecord[]> {
    const entities = await this.readManager()
      .createQueryBuilder(WagerTransactionEntity, 'transaction')
      .select('*')
      .where({
        status: 'PENDING_REFERENCE',
        nextAttemptAt: { $lte: now },
      })
      .orderBy({ nextAttemptAt: 'asc', id: 'asc' })
      .limit(limit)
      .setLockMode(LockMode.PESSIMISTIC_PARTIAL_WRITE)
      .getResultList();

    return entities.map((entity) => this.toRecord(entity));
  }

  async findPendingReferenceForUpdate(
    transactionId: string,
    now: Date,
  ): Promise<WagerTransactionRecord | null> {
    const entities = await this.readManager()
      .createQueryBuilder(WagerTransactionEntity, 'transaction')
      .select('*')
      .where({
        id: transactionId,
        status: 'PENDING_REFERENCE',
        nextAttemptAt: { $lte: now },
      })
      .limit(1)
      .setLockMode(LockMode.PESSIMISTIC_PARTIAL_WRITE)
      .getResultList();

    return entities[0] ? this.toRecord(entities[0]) : null;
  }

  async update(transaction: WagerTransaction): Promise<void> {
    await this.entityManager.nativeUpdate(
      WagerTransactionEntity,
      { id: transaction.id },
      {
        status: transaction.status,
        failureCode: transaction.failureCode,
        resultBalanceAmount: transaction.resultBalance?.amount,
        resultBalanceCurrency: transaction.resultBalance?.currency,
        pendingSince: transaction.pendingSince,
        nextAttemptAt: transaction.nextAttemptAt,
        pendingAttempts: transaction.pendingAttempts,
        referenceTransactionId: transaction.referenceTransactionId,
        processedAt: transaction.processedAt,
      },
    );
  }

  private toRecord(entity: WagerTransactionEntity): WagerTransactionRecord {
    return {
      id: entity.id,
      providerId: entity.providerId,
      externalTransactionId: entity.externalTransactionId,
      idempotencyKey: entity.idempotencyKey ?? null,
      payloadHash: entity.payloadHash ?? null,
      walletId: entity.walletId,
      playerId: entity.playerId,
      roundId: entity.roundId ?? null,
      gameId: entity.gameId ?? null,
      referenceExternalTransactionId: entity.referenceExternalTransactionId ?? null,
      referenceTransactionId: entity.referenceTransactionId ?? null,
      pendingSince: entity.pendingSince ?? null,
      nextAttemptAt: entity.nextAttemptAt ?? null,
      pendingAttempts: entity.pendingAttempts,
      kind: entity.kind,
      amount: entity.amount,
      currency: entity.currency,
      status: entity.status,
      failureCode: entity.failureCode ?? null,
      resultBalanceAmount: entity.resultBalanceAmount ?? null,
      resultBalanceCurrency: entity.resultBalanceCurrency ?? null,
      createdAt: entity.createdAt,
      processedAt: entity.processedAt ?? null,
    };
  }

  private readManager(): EntityManager {
    const context = this.entityManager.getContext(false);
    return context.global ? context.fork() : context;
  }
}

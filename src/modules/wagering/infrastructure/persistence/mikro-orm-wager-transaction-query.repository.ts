import { EntityManager } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';

import type {
  WagerTransactionQueryRepository,
  WagerTransactionReadModel,
} from '../../application/ports/wager-transaction-query-repository.port';
import { WagerTransactionEntity } from './entities/wager-transaction.entity';

const READ_FIELDS = [
  'id',
  'providerId',
  'externalTransactionId',
  'walletId',
  'playerId',
  'roundId',
  'gameId',
  'referenceExternalTransactionId',
  'referenceTransactionId',
  'pendingSince',
  'nextAttemptAt',
  'pendingAttempts',
  'kind',
  'amount',
  'currency',
  'status',
  'failureCode',
  'resultBalanceAmount',
  'resultBalanceCurrency',
  'createdAt',
  'processedAt',
] as const;

@Injectable()
export class MikroOrmWagerTransactionQueryRepository implements WagerTransactionQueryRepository {
  constructor(private readonly entityManager: EntityManager) {}

  findById(transactionId: string): Promise<WagerTransactionReadModel | null> {
    return this.findOne({ id: transactionId });
  }

  findByProviderExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransactionReadModel | null> {
    return this.findOne({ providerId, externalTransactionId });
  }

  private async findOne(where: Record<string, string>): Promise<WagerTransactionReadModel | null> {
    const entities = await this.readManager()
      .createQueryBuilder(WagerTransactionEntity, 'transaction')
      .select([...READ_FIELDS])
      .where(where)
      .limit(1)
      .getResultList();
    const entity = entities[0];
    return entity ? this.toReadModel(entity) : null;
  }

  private toReadModel(entity: WagerTransactionEntity): WagerTransactionReadModel {
    return {
      id: entity.id,
      providerId: entity.providerId,
      externalTransactionId: entity.externalTransactionId,
      walletId: entity.walletId,
      playerId: entity.playerId,
      roundId: entity.roundId ?? null,
      gameId: entity.gameId ?? null,
      referenceExternalTransactionId: entity.referenceExternalTransactionId ?? null,
      referenceTransactionId: entity.referenceTransactionId ?? null,
      pendingSince: this.copyDate(entity.pendingSince),
      nextAttemptAt: this.copyDate(entity.nextAttemptAt),
      pendingAttempts: entity.pendingAttempts,
      kind: entity.kind as WagerTransactionReadModel['kind'],
      amount: entity.amount,
      currency: entity.currency,
      status: entity.status as WagerTransactionReadModel['status'],
      failureCode: (entity.failureCode ?? null) as WagerTransactionReadModel['failureCode'],
      resultBalanceAmount: entity.resultBalanceAmount ?? null,
      resultBalanceCurrency: entity.resultBalanceCurrency ?? null,
      createdAt: new Date(entity.createdAt.getTime()),
      processedAt: this.copyDate(entity.processedAt),
    };
  }

  private copyDate(value: Date | undefined): Date | null {
    return value ? new Date(value.getTime()) : null;
  }

  private readManager(): EntityManager {
    const context = this.entityManager.getContext(false);
    return context.global ? context.fork() : context;
  }
}

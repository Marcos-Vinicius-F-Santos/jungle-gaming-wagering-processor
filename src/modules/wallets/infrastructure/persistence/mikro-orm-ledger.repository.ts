import { EntityManager } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';

import { Money } from '../../../../shared/domain/money';
import type {
  LedgerCursor,
  LedgerEntryReadModel,
  LedgerPage,
  LedgerQueryRepository,
} from '../../application/ports/ledger-query-repository.port';
import type { LedgerRepository } from '../../application/ports/ledger-repository.port';
import { WalletLedgerEntry } from '../../domain/wallet-ledger-entry';
import { WalletLedgerEntryEntity } from './entities/wallet-ledger-entry.entity';

@Injectable()
export class MikroOrmLedgerRepository implements LedgerRepository<WalletLedgerEntry>, LedgerQueryRepository {
  constructor(private readonly entityManager: EntityManager) {}

  async save(entry: WalletLedgerEntry): Promise<void> {
    const entity = this.entityManager.create(WalletLedgerEntryEntity, {
      id: entry.id,
      walletId: entry.walletId,
      transactionId: entry.transactionId,
      direction: entry.direction,
      amount: entry.amount.amount,
      currency: entry.amount.currency,
      balanceBefore: entry.balanceBefore.amount,
      balanceAfter: entry.balanceAfter.amount,
      createdAt: entry.createdAt,
    });
    this.entityManager.persist(entity);
    await this.entityManager.flush();
  }

  async findByWalletId(walletId: string): Promise<readonly WalletLedgerEntry[]> {
    const entities = await this.readManager().find(WalletLedgerEntryEntity, { walletId }, { orderBy: { createdAt: 'asc' } });
    return entities.map((entity) => {
      const amount = Money.of(entity.amount, entity.currency);
      const balanceBefore = Money.of(entity.balanceBefore, entity.currency);
      return entity.direction === 'CREDIT'
        ? WalletLedgerEntry.credit(entity.id, entity.walletId, entity.transactionId, amount, balanceBefore, entity.createdAt)
        : WalletLedgerEntry.debit(entity.id, entity.walletId, entity.transactionId, amount, balanceBefore, entity.createdAt);
    });
  }

  async findPage(walletId: string, cursor: LedgerCursor | undefined, limit: number): Promise<LedgerPage> {
    const query = this.readManager()
      .createQueryBuilder(WalletLedgerEntryEntity, 'ledger')
      .select(['id', 'transactionId', 'walletId', 'direction', 'amount', 'currency', 'balanceBefore', 'balanceAfter', 'createdAt'])
      .where({ walletId });

    if (cursor) {
      query.andWhere(
        '(ledger.created_at < ? OR (ledger.created_at = ? AND ledger.id < ?))',
        [cursor.createdAt, cursor.createdAt, cursor.id],
      );
    }

    const entities = await query
      .orderBy({ createdAt: 'desc', id: 'desc' })
      .limit(limit + 1)
      .getResultList();
    const hasNextPage = entities.length > limit;
    const items = (hasNextPage ? entities.slice(0, limit) : entities).map(
      (entity): LedgerEntryReadModel => ({
        id: entity.id,
        transactionId: entity.transactionId,
        walletId: entity.walletId,
        direction: entity.direction as 'DEBIT' | 'CREDIT',
        amount: entity.amount,
        currency: entity.currency,
        balanceBefore: entity.balanceBefore,
        balanceAfter: entity.balanceAfter,
        createdAt: new Date(entity.createdAt.getTime()),
      }),
    );

    return { items, hasNextPage };
  }

  private readManager(): EntityManager {
    const context = this.entityManager.getContext(false);
    return context.global ? context.fork() : context;
  }
}

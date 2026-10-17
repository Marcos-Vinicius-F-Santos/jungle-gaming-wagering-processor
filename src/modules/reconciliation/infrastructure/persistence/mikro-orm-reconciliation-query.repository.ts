import { EntityManager } from '@mikro-orm/postgresql';
import { IsolationLevel } from '@mikro-orm/core';
import { Injectable } from '@nestjs/common';

import type {
  ReconciliationLedgerEntrySnapshot,
  ReconciliationQueryRepository,
  ReconciliationSnapshot,
} from '../../application/ports/reconciliation-query-repository.port';
import { WalletEntity } from '../../../wallets/infrastructure/persistence/entities/wallet.entity';
import { WalletLedgerEntryEntity } from '../../../wallets/infrastructure/persistence/entities/wallet-ledger-entry.entity';

const WALLET_FIELDS = ['id', 'currency', 'balanceAmount'] as const;
const LEDGER_FIELDS = [
  'id',
  'direction',
  'amount',
  'currency',
  'balanceBefore',
  'balanceAfter',
  'createdAt',
] as const;

@Injectable()
export class MikroOrmReconciliationQueryRepository implements ReconciliationQueryRepository {
  constructor(private readonly entityManager: EntityManager) {}

  async findSnapshot(walletId: string): Promise<ReconciliationSnapshot | null> {
    return this.entityManager.transactional(
      (manager) => this.findSnapshotInTransaction(manager, walletId),
      {
        isolationLevel: IsolationLevel.REPEATABLE_READ,
        readOnly: true,
      },
    );
  }

  private async findSnapshotInTransaction(manager: EntityManager, walletId: string): Promise<ReconciliationSnapshot | null> {
    const wallet = await manager.findOne(WalletEntity, { id: walletId }, { fields: WALLET_FIELDS });
    if (!wallet) {
      return null;
    }

    const entries = await manager.find(
      WalletLedgerEntryEntity,
      { walletId },
      {
        fields: LEDGER_FIELDS,
        orderBy: { createdAt: 'asc', id: 'asc' },
      },
    );

    return {
      walletId: wallet.id,
      currency: wallet.currency,
      storedBalance: wallet.balanceAmount,
      entries: entries.map(
        (entry): ReconciliationLedgerEntrySnapshot => ({
          id: entry.id,
          direction: entry.direction as ReconciliationLedgerEntrySnapshot['direction'],
          amount: entry.amount,
          currency: entry.currency,
          balanceBefore: entry.balanceBefore,
          balanceAfter: entry.balanceAfter,
          createdAt: new Date(entry.createdAt.getTime()),
        }),
      ),
    };
  }

}

import { EntityManager } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';

import { Wallet } from '../../domain/wallet';
import { Money } from '../../../../shared/domain/money';
import type { WalletRepository } from '../../application/ports/wallet-repository.port';
import { WalletEntity } from './entities/wallet.entity';

@Injectable()
export class MikroOrmWalletRepository implements WalletRepository<Wallet> {
  constructor(private readonly entityManager: EntityManager) {}

  async findById(walletId: string): Promise<Wallet | null> {
    const entity = await this.readManager().findOne(WalletEntity, { id: walletId });
    return entity ? this.toDomain(entity) : null;
  }

  async findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | null> {
    const entity = await this.readManager().findOne(WalletEntity, { playerId, currency });
    return entity ? this.toDomain(entity) : null;
  }

  async save(wallet: Wallet): Promise<void> {
    const entity = this.entityManager.create(WalletEntity, {
      id: wallet.id,
      playerId: wallet.playerId,
      currency: wallet.currency,
      balanceAmount: wallet.balance.amount,
      version: wallet.version,
      createdAt: wallet.createdAt,
      updatedAt: wallet.updatedAt,
    });
    this.entityManager.persist(entity);
    await this.entityManager.flush();
  }

  async updateBalanceIfVersion(
    walletId: string,
    expectedVersion: number,
    nextBalanceAmount: string,
    nextVersion: number,
    updatedAt: Date,
  ): Promise<boolean> {
    const affected = await this.entityManager.nativeUpdate(
      WalletEntity,
      { id: walletId, version: expectedVersion },
      {
        balanceAmount: nextBalanceAmount,
        version: nextVersion,
        updatedAt,
      },
    );
    return affected === 1;
  }

  private toDomain(entity: WalletEntity): Wallet {
    return Wallet.rehydrate({
      id: entity.id,
      playerId: entity.playerId,
      balance: Money.of(entity.balanceAmount, entity.currency),
      version: entity.version,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
    });
  }

  private readManager(): EntityManager {
    const context = this.entityManager.getContext(false);
    return context.global ? context.fork() : context;
  }
}

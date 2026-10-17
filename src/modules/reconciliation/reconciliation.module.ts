import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';

import { WalletsModule } from '../wallets/wallets.module';
import { WalletEntity } from '../wallets/infrastructure/persistence/entities/wallet.entity';
import { WalletLedgerEntryEntity } from '../wallets/infrastructure/persistence/entities/wallet-ledger-entry.entity';
import { ReconcileWalletUseCase } from './application/reconcile-wallet.use-case';
import { ReconciliationCalculator } from './application/reconciliation-calculator';
import { RECONCILIATION_QUERY_REPOSITORY } from './application/ports/reconciliation-query-repository.port';
import { MikroOrmReconciliationQueryRepository } from './infrastructure/persistence/mikro-orm-reconciliation-query.repository';
import { ReconciliationController } from './http/reconciliation.controller';

@Module({
  imports: [
    WalletsModule,
    MikroOrmModule.forFeature([WalletEntity, WalletLedgerEntryEntity]),
  ],
  controllers: [ReconciliationController],
  providers: [
    ReconcileWalletUseCase,
    ReconciliationCalculator,
    MikroOrmReconciliationQueryRepository,
    { provide: RECONCILIATION_QUERY_REPOSITORY, useExisting: MikroOrmReconciliationQueryRepository },
  ],
  exports: [ReconcileWalletUseCase],
})
export class ReconciliationModule {}

import { forwardRef, Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';

import { CLOCK } from '../../shared/application/ports/clock.port';
import { ID_GENERATOR } from '../../shared/application/ports/id-generator.port';
import { UNIT_OF_WORK } from '../../shared/application/ports/unit-of-work.port';
import { LOGGER } from '../../shared/application/ports/logger.port';
import { METRICS } from '../../shared/application/ports/metrics.port';
import { MikroOrmUnitOfWork } from '../../shared/infrastructure/database/mikro-orm-unit-of-work';
import { SystemClock } from '../../shared/infrastructure/clock/system-clock';
import { UuidV7Generator } from '../../shared/infrastructure/ids/uuid-v7.generator';
import { StructuredLogger } from '../../shared/infrastructure/logging/structured-logger';
import { InMemoryMetrics } from '../../shared/infrastructure/metrics/in-memory-metrics';
import { WageringModule } from '../wagering/wagering.module';
import { LedgerModule } from '../ledger/ledger.module';
import { CreateWalletUseCase } from './application/create-wallet.use-case';
import { GetWalletUseCase } from './application/get-wallet.use-case';
import { ListLedgerUseCase } from './application/list-ledger.use-case';
import { LedgerCursorCodec } from './application/ledger-cursor.codec';
import { LEDGER_QUERY_REPOSITORY } from './application/ports/ledger-query-repository.port';
import { LEDGER_REPOSITORY } from './application/ports/ledger-repository.port';
import { WALLET_REPOSITORY } from './application/ports/wallet-repository.port';
import { MikroOrmLedgerRepository } from './infrastructure/persistence/mikro-orm-ledger.repository';
import { WalletEntity } from './infrastructure/persistence/entities/wallet.entity';
import { WalletLedgerEntryEntity } from './infrastructure/persistence/entities/wallet-ledger-entry.entity';
import { MikroOrmWalletRepository } from './infrastructure/persistence/mikro-orm-wallet.repository';
import { IsIso4217CurrencyConstraint } from './http/validators/is-iso4217-currency.validator';
import { WalletsController } from './http/wallets.controller';

@Module({
  imports: [MikroOrmModule.forFeature([WalletEntity, WalletLedgerEntryEntity]), LedgerModule, forwardRef(() => WageringModule)],
  controllers: [WalletsController],
  providers: [
    CreateWalletUseCase,
    GetWalletUseCase,
    ListLedgerUseCase,
    LedgerCursorCodec,
    MikroOrmUnitOfWork,
    SystemClock,
    UuidV7Generator,
    StructuredLogger,
    InMemoryMetrics,
    MikroOrmWalletRepository,
    MikroOrmLedgerRepository,
    { provide: CLOCK, useExisting: SystemClock },
    { provide: ID_GENERATOR, useExisting: UuidV7Generator },
    { provide: UNIT_OF_WORK, useExisting: MikroOrmUnitOfWork },
    { provide: LOGGER, useExisting: StructuredLogger },
    { provide: METRICS, useExisting: InMemoryMetrics },
    { provide: WALLET_REPOSITORY, useExisting: MikroOrmWalletRepository },
    { provide: LEDGER_REPOSITORY, useExisting: MikroOrmLedgerRepository },
    { provide: LEDGER_QUERY_REPOSITORY, useExisting: MikroOrmLedgerRepository },
    IsIso4217CurrencyConstraint,
  ],
  exports: [
    CreateWalletUseCase,
    GetWalletUseCase,
    WALLET_REPOSITORY,
    LEDGER_REPOSITORY,
    LEDGER_QUERY_REPOSITORY,
    UNIT_OF_WORK,
    CLOCK,
    ID_GENERATOR,
    LOGGER,
    METRICS,
  ],
})
export class WalletsModule {}

import { forwardRef, Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';

import { CLOCK } from '../../shared/application/ports/clock.port';
import { ID_GENERATOR } from '../../shared/application/ports/id-generator.port';
import { LOGGER } from '../../shared/application/ports/logger.port';
import { UNIT_OF_WORK } from '../../shared/application/ports/unit-of-work.port';
import { LEDGER_REPOSITORY } from '../wallets/application/ports/ledger-repository.port';
import { WALLET_REPOSITORY } from '../wallets/application/ports/wallet-repository.port';
import { WalletsModule } from '../wallets/wallets.module';
import { ProcessWagerTransactionUseCase } from './application/process-wager-transaction.use-case';
import { GetWagerTransactionUseCase } from './application/get-wager-transaction.use-case';
import { WAGER_TRANSACTION_REPOSITORY } from './application/ports/wager-transaction-repository.port';
import { PAYLOAD_HASHER } from './application/ports/payload-hasher.port';
import { CanonicalPayloadHasher } from './application/canonical-payload-hasher';
import { WagerTransactionEntity } from './infrastructure/persistence/entities/wager-transaction.entity';
import { MikroOrmWagerTransactionRepository } from './infrastructure/persistence/mikro-orm-wager-transaction.repository';
import { WAGER_TRANSACTION_QUERY_REPOSITORY } from './application/ports/wager-transaction-query-repository.port';
import { MikroOrmWagerTransactionQueryRepository } from './infrastructure/persistence/mikro-orm-wager-transaction-query.repository';
import { WageringController } from './http/wagering.controller';
import { WageringTransactionQueryController } from './http/wagering-transaction-query.controller';
import { OutboxModule } from '../messaging/outbox/outbox.module';
import { PendingReferenceWorker } from './application/pending-reference.worker';
import { LedgerModule } from '../ledger/ledger.module';

@Module({
  imports: [MikroOrmModule.forFeature([WagerTransactionEntity]), forwardRef(() => WalletsModule), LedgerModule, OutboxModule],
  controllers: [WageringController, WageringTransactionQueryController],
  providers: [
    MikroOrmWagerTransactionRepository,
    MikroOrmWagerTransactionQueryRepository,
    CanonicalPayloadHasher,
    ProcessWagerTransactionUseCase,
    GetWagerTransactionUseCase,
    PendingReferenceWorker,
    { provide: WAGER_TRANSACTION_REPOSITORY, useExisting: MikroOrmWagerTransactionRepository },
    { provide: WAGER_TRANSACTION_QUERY_REPOSITORY, useExisting: MikroOrmWagerTransactionQueryRepository },
    { provide: PAYLOAD_HASHER, useExisting: CanonicalPayloadHasher },
  ],
  exports: [
    ProcessWagerTransactionUseCase,
    GetWagerTransactionUseCase,
    WAGER_TRANSACTION_REPOSITORY,
    WAGER_TRANSACTION_QUERY_REPOSITORY,
    PAYLOAD_HASHER,
  ],
})
export class WageringModule {}

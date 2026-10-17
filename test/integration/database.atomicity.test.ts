import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { INestApplicationContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { v4 } from 'uuid';

import { EntityManager } from '@mikro-orm/postgresql';
import { AppModule } from '../../src/app.module';
import { CreateWalletUseCase } from '../../src/modules/wallets/application/create-wallet.use-case';
import { LEDGER_REPOSITORY } from '../../src/modules/wallets/application/ports/ledger-repository.port';
import type { LedgerRepository } from '../../src/modules/wallets/application/ports/ledger-repository.port';
import { WALLET_REPOSITORY } from '../../src/modules/wallets/application/ports/wallet-repository.port';
import type { WalletRepository } from '../../src/modules/wallets/application/ports/wallet-repository.port';
import { WAGER_TRANSACTION_REPOSITORY } from '../../src/modules/wagering/application/ports/wager-transaction-repository.port';
import type { WagerTransactionRepository } from '../../src/modules/wagering/application/ports/wager-transaction-repository.port';
import { Wallet } from '../../src/modules/wallets/domain/wallet';
import { WalletLedgerEntry } from '../../src/modules/wallets/domain/wallet-ledger-entry';
import { WagerTransaction } from '../../src/modules/wagering/domain/wager-transaction';
import { UNIT_OF_WORK } from '../../src/shared/application/ports/unit-of-work.port';
import type { UnitOfWork } from '../../src/shared/application/ports/unit-of-work.port';
import { CLOCK } from '../../src/shared/application/ports/clock.port';
import type { Clock } from '../../src/shared/application/ports/clock.port';
import { ID_GENERATOR } from '../../src/shared/application/ports/id-generator.port';
import type { IdGenerator } from '../../src/shared/application/ports/id-generator.port';
import { LOGGER } from '../../src/shared/application/ports/logger.port';
import type { AppLogger } from '../../src/shared/application/ports/logger.port';
import { Money } from '../../src/shared/domain/money';

describe('PostgreSQL atomicity and ledger protection', () => {
  let app: INestApplicationContext;
  let entityManager: EntityManager;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef;
    entityManager = app.get(EntityManager);
  });

  afterAll(async () => {
    await app.close();
  });

  test('rolls back wallet and OPENING when ledger persistence fails', async () => {
    const walletRepository = app.get<WalletRepository<Wallet>>(WALLET_REPOSITORY);
    const transactionRepository = app.get<WagerTransactionRepository<WagerTransaction>>(WAGER_TRANSACTION_REPOSITORY);
    const unitOfWork = app.get<UnitOfWork>(UNIT_OF_WORK);
    const clock = app.get<Clock>(CLOCK);
    const idGenerator = app.get<IdGenerator>(ID_GENERATOR);
    const logger = app.get<AppLogger>(LOGGER);
    const failingLedgerRepository: LedgerRepository<WalletLedgerEntry> = {
      save: async () => {
        throw new Error('forced ledger failure');
      },
      findByWalletId: async () => [],
    };
    const useCase = new CreateWalletUseCase(
      walletRepository,
      transactionRepository,
      failingLedgerRepository,
      unitOfWork,
      clock,
      idGenerator,
      logger,
    );
    const playerId = v4();

    await expect(useCase.execute({ playerId, initialBalance: Money.of('9.00', 'BRL') })).rejects.toThrow('forced ledger failure');

    const rows = await entityManager.getConnection().execute<{ wallets: string; transactions: string; ledger: string }[]>(
      `select
         (select count(*) from wallets where player_id = ?) as wallets,
         (select count(*) from wager_transactions where player_id = ?) as transactions,
         (select count(*) from wallet_ledger_entries where wallet_id in (select id from wallets where player_id = ?)) as ledger`,
      [playerId, playerId, playerId],
    );
    expect(rows[0]).toEqual({ wallets: '0', transactions: '0', ledger: '0' });
  });

  test('rejects direct updates to an existing ledger entry', async () => {
    await app.get(CreateWalletUseCase).execute({ playerId: v4(), initialBalance: Money.of('3.00', 'BRL') });
    const rows = await entityManager.getConnection().execute<{ id: string; amount: string }[]>(
      'select id, amount from wallet_ledger_entries order by created_at asc limit 1',
    );
    expect(rows).toHaveLength(1);

    await expect(
      entityManager.getConnection().execute('update wallet_ledger_entries set amount = amount where id = ?', [rows[0].id]),
    ).rejects.toThrow('wallet ledger entries are immutable');
  });
});

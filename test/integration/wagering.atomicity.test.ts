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
import { ProcessWagerTransactionUseCase } from '../../src/modules/wagering/application/process-wager-transaction.use-case';
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
import { PAYLOAD_HASHER } from '../../src/modules/wagering/application/ports/payload-hasher.port';
import type { PayloadHasher } from '../../src/modules/wagering/application/ports/payload-hasher.port';
import { Money } from '../../src/shared/domain/money';

describe('PostgreSQL wagering migration and atomicity', () => {
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

  test('has the provider-scoped idempotency index and replay snapshot constraints', async () => {
    const indexes = await entityManager.getConnection().execute<{ indexname: string; indexdef: string }[]>(
      `select indexname, indexdef
       from pg_indexes
       where schemaname = current_schema() and tablename = 'wager_transactions'`,
    );
    const columns = await entityManager.getConnection().execute<{ column_name: string }[]>(
      `select column_name
       from information_schema.columns
       where table_schema = current_schema()
         and table_name = 'wager_transactions'
         and column_name in ('result_balance_amount', 'result_balance_currency')`,
    );
    const constraints = await entityManager.getConnection().execute<{ constraint_name: string }[]>(
      `select constraint_name
       from information_schema.table_constraints
       where table_schema = current_schema()
         and table_name = 'wager_transactions'
         and constraint_name in (
           'wager_transactions_result_balance_pair',
           'wager_transactions_result_balance_non_negative',
           'wager_transactions_result_currency_shape'
         )`,
    );

    const idempotencyIndex = indexes.find(({ indexname }) => indexname === 'wager_transactions_provider_idempotency_key_unique');
    expect(idempotencyIndex?.indexdef).toContain('(provider_id, idempotency_key)');
    expect(columns.map(({ column_name }) => column_name).sort()).toEqual([
      'result_balance_amount',
      'result_balance_currency',
    ]);
    expect(constraints.map(({ constraint_name }) => constraint_name).sort()).toEqual([
      'wager_transactions_result_balance_non_negative',
      'wager_transactions_result_balance_pair',
      'wager_transactions_result_currency_shape',
    ]);
  });

  test('rolls back transaction, wallet and ledger when BET ledger persistence fails', async () => {
    const createWallet = app.get(CreateWalletUseCase);
    const created = await createWallet.execute({ playerId: v4(), initialBalance: Money.of('100.00', 'BRL') });
    const walletRepository = app.get<WalletRepository<Wallet>>(WALLET_REPOSITORY);
    const transactionRepository = app.get<WagerTransactionRepository<WagerTransaction>>(WAGER_TRANSACTION_REPOSITORY);
    const actualLedgerRepository = app.get<LedgerRepository<WalletLedgerEntry>>(LEDGER_REPOSITORY);
    const unitOfWork = app.get<UnitOfWork>(UNIT_OF_WORK);
    const clock = app.get<Clock>(CLOCK);
    const idGenerator = app.get<IdGenerator>(ID_GENERATOR);
    const logger = app.get<AppLogger>(LOGGER);
    const payloadHasher = app.get<PayloadHasher>(PAYLOAD_HASHER);
    const failingLedgerRepository: LedgerRepository<WalletLedgerEntry> = {
      save: async () => {
        throw new Error('forced BET ledger failure');
      },
      findByWalletId: (walletId) => actualLedgerRepository.findByWalletId(walletId),
    };
    const process = new ProcessWagerTransactionUseCase(
      walletRepository,
      transactionRepository,
      failingLedgerRepository,
      unitOfWork,
      clock,
      idGenerator,
      payloadHasher,
      logger,
    );
    const externalTransactionId = `external-${v4()}`;

    await expect(process.execute({
      providerId: 'provider-atomicity',
      externalTransactionId,
      idempotencyKey: `key-${v4()}`,
      playerId: created.playerId,
      walletId: created.id,
      roundId: 'round-atomicity',
      gameId: 'game-atomicity',
      kind: 'BET',
      money: { amount: '40.00', currency: 'BRL' },
    })).rejects.toThrow('forced BET ledger failure');

    const rows = await entityManager.getConnection().execute<{
      balance_amount: string;
      version: number;
      transactions: string;
      bets: string;
      ledger: string;
      journals: string;
    }[]>(
      `select
         (select balance_amount from wallets where id = ?) as balance_amount,
         (select version from wallets where id = ?) as version,
         (select count(*) from wager_transactions where wallet_id = ?) as transactions,
         (select count(*) from wager_transactions where wallet_id = ? and kind = 'BET') as bets,
         (select count(*) from wallet_ledger_entries where wallet_id = ?) as ledger,
         (select count(*) from ledger_journal_entries where transaction_id in (select id from wager_transactions where provider_id = 'provider-atomicity')) as journals`,
      [created.id, created.id, created.id, created.id, created.id],
    );

    expect(rows[0]).toEqual({
      balance_amount: '100.00',
      version: 1,
      transactions: '1',
      bets: '0',
      ledger: '1',
      journals: '0',
    });
  });
});

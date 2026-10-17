import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { INestApplicationContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { EntityManager } from '@mikro-orm/postgresql';
import { v4 } from 'uuid';

import { AppModule } from '../../src/app.module';
import { CreateWalletUseCase } from '../../src/modules/wallets/application/create-wallet.use-case';
import { ProcessWagerTransactionUseCase } from '../../src/modules/wagering/application/process-wager-transaction.use-case';
import { OUTBOX_REPOSITORY } from '../../src/modules/messaging/outbox/application/ports/outbox-repository.port';
import type { OutboxRepository } from '../../src/modules/messaging/outbox/application/ports/outbox-repository.port';
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
import { PAYLOAD_HASHER } from '../../src/modules/wagering/application/ports/payload-hasher.port';
import type { PayloadHasher } from '../../src/modules/wagering/application/ports/payload-hasher.port';
import { Money } from '../../src/shared/domain/money';

describe('WIN/LOSS transactional Outbox', () => {
  let app: INestApplicationContext;
  let entityManager: EntityManager;

  beforeAll(async () => {
    app = await Test.createTestingModule({ imports: [AppModule] }).compile();
    entityManager = app.get(EntityManager);
  });

  afterAll(async () => {
    await app.close();
  });

  test('has pending-reference and Outbox schema', async () => {
    const columns = await entityManager.getConnection().execute<{ table_name: string; column_name: string }[]>(
      `select table_name, column_name
       from information_schema.columns
       where table_schema = current_schema()
         and ((table_name = 'wager_transactions' and column_name in ('reference_external_transaction_id', 'pending_since', 'next_attempt_at', 'pending_attempts'))
           or (table_name = 'outbox_messages' and column_name in ('event_id', 'event_type', 'payload', 'attempts', 'next_attempt_at', 'published_at')))`,
    );

    expect(columns).toEqual(expect.arrayContaining([
      { table_name: 'wager_transactions', column_name: 'reference_external_transaction_id' },
      { table_name: 'wager_transactions', column_name: 'pending_since' },
      { table_name: 'wager_transactions', column_name: 'next_attempt_at' },
      { table_name: 'wager_transactions', column_name: 'pending_attempts' },
      { table_name: 'outbox_messages', column_name: 'event_id' },
      { table_name: 'outbox_messages', column_name: 'event_type' },
      { table_name: 'outbox_messages', column_name: 'payload' },
    ]));
  });

  test('rolls back wallet, transaction, ledger and Outbox when Outbox persistence fails', async () => {
    const createWallet = app.get(CreateWalletUseCase);
    const created = await createWallet.execute({ playerId: v4(), initialBalance: Money.of('100.00', 'BRL') });
    const useCase = new ProcessWagerTransactionUseCase(
      app.get<WalletRepository<Wallet>>(WALLET_REPOSITORY),
      app.get<WagerTransactionRepository<WagerTransaction>>(WAGER_TRANSACTION_REPOSITORY),
      app.get<LedgerRepository<WalletLedgerEntry>>(LEDGER_REPOSITORY),
      app.get<UnitOfWork>(UNIT_OF_WORK),
      app.get<Clock>(CLOCK),
      app.get<IdGenerator>(ID_GENERATOR),
      app.get<PayloadHasher>(PAYLOAD_HASHER),
      app.get<AppLogger>(LOGGER),
      {
        enqueue: async () => { throw new Error('forced outbox failure'); },
        claimDue: async () => [],
        markPublished: async () => false,
        scheduleRetry: async () => false,
        markIntervention: async () => false,
        getLag: async () => ({ pendingCount: 0 }),
      } satisfies OutboxRepository,
    );

    await expect(useCase.execute({
      providerId: 'provider-outbox',
      externalTransactionId: `win-${v4()}`,
      idempotencyKey: `key-${v4()}`,
      playerId: created.playerId,
      walletId: created.id,
      roundId: 'round-outbox',
      gameId: 'game-outbox',
      kind: 'WIN',
      money: { amount: '20.00', currency: 'BRL' },
    })).rejects.toThrow('forced outbox failure');

    const rows = await entityManager.getConnection().execute<{ balance: string; version: number; transactions: string; ledger: string; journals: string; outbox: string }[]>(
      `select
        (select balance_amount from wallets where id = ?) as balance,
        (select version from wallets where id = ?) as version,
        (select count(*) from wager_transactions where wallet_id = ? and provider_id = 'provider-outbox') as transactions,
        (select count(*) from wallet_ledger_entries where wallet_id = ? and transaction_id in (select id from wager_transactions where provider_id = 'provider-outbox')) as ledger,
        (select count(*) from ledger_journal_entries where transaction_id in (select id from wager_transactions where provider_id = 'provider-outbox')) as journals,
        (select count(*) from outbox_messages where aggregate_id in (select id from wager_transactions where provider_id = 'provider-outbox')) as outbox`,
      [created.id, created.id, created.id, created.id, created.id],
    );

    expect(rows[0]).toEqual({ balance: '100.00', version: 1, transactions: '0', ledger: '0', journals: '0', outbox: '0' });
  });
});

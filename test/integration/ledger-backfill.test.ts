import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { INestApplicationContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { EntityManager } from '@mikro-orm/postgresql';
import { v7 } from 'uuid';

import { AppModule } from '../../src/app.module';
import { LedgerBackfillService } from '../../src/modules/ledger/application/ledger-backfill.service';
import { CreateWalletUseCase } from '../../src/modules/wallets/application/create-wallet.use-case';
import { Money } from '../../src/shared/domain/money';

describe('ledger historical backfill', () => {
  let app: INestApplicationContext;
  let entityManager: EntityManager;
  let backfill: LedgerBackfillService;

  beforeAll(async () => {
    app = await Test.createTestingModule({ imports: [AppModule] }).compile();
    entityManager = app.get(EntityManager);
    backfill = app.get(LedgerBackfillService);
  });

  afterAll(async () => {
    await app.close();
  });

  test('converts a legacy entry twice without changing business data', async () => {
    const wallet = await app.get(CreateWalletUseCase).execute({ playerId: v7(), initialBalance: Money.of('10.00', 'CAD') });
    const transactionId = v7();
    const ledgerEntryId = v7();
    const createdAt = new Date('2026-01-01T00:00:00.000Z');
    await entityManager.getConnection().execute(
      `update wallets set balance_amount = '8.00', version = 2 where id = ?`,
      [wallet.id],
    );
    await entityManager.getConnection().execute(
      `insert into wager_transactions
         (id, provider_id, external_transaction_id, wallet_id, player_id, kind, amount, currency, status, created_at, processed_at, result_balance_amount, result_balance_currency)
       values (?, 'backfill-test', ?, ?, ?, 'BET', 2.00, 'CAD', 'PROCESSED', ?, ?, '8.00', 'CAD')`,
      [transactionId, `external-${transactionId}`, wallet.id, wallet.playerId, createdAt, createdAt],
    );
    await entityManager.getConnection().execute(
      `insert into wallet_ledger_entries
         (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
       values (?, ?, ?, 'DEBIT', 2.00, 'CAD', 10.00, 8.00, ?)`,
      [ledgerEntryId, wallet.id, transactionId, createdAt],
    );

    const before = await entityManager.getConnection().execute<{ balance_amount: string; version: number; updated_at: Date }[]>(
      `select balance_amount, version, updated_at from wallets where id = ?`,
      [wallet.id],
    );
    const first = await backfill.execute();
    const afterFirst = await entityManager.getConnection().execute<{ balance_amount: string; version: number; updated_at: Date }[]>(
      `select balance_amount, version, updated_at from wallets where id = ?`,
      [wallet.id],
    );
    const journal = await entityManager.getConnection().execute<{ journals: string; postings: string; policy_version: string }[]>(
      `select count(distinct journal.id)::text as journals,
              count(posting.id)::text as postings,
              min(journal.policy_version) as policy_version
         from ledger_journal_entries journal
         join ledger_postings posting on posting.journal_entry_id = journal.id
        where journal.transaction_id = ?`,
      [transactionId],
    );

    expect(first.converted).toBeGreaterThan(0);
    expect(afterFirst).toEqual(before);
    expect(journal[0]).toEqual({ journals: '1', postings: '2', policy_version: 'legacy-v1' });

    const second = await backfill.execute();
    const afterSecond = await entityManager.getConnection().execute<{ balance_amount: string; version: number; updated_at: Date }[]>(
      `select balance_amount, version, updated_at from wallets where id = ?`,
      [wallet.id],
    );
    const journalCount = await entityManager.getConnection().execute<{ journals: string; postings: string }[]>(
      `select count(distinct journal.id)::text as journals, count(posting.id)::text as postings
         from ledger_journal_entries journal
         join ledger_postings posting on posting.journal_entry_id = journal.id
        where journal.transaction_id = ?`,
      [transactionId],
    );

    expect(second.converted).toBe(0);
    expect(afterSecond).toEqual(before);
    expect(journalCount[0]).toEqual({ journals: '1', postings: '2' });
  }, 30_000);
});

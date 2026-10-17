import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { INestApplicationContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { EntityManager } from '@mikro-orm/postgresql';
import { v7 } from 'uuid';

import { AppModule } from '../../src/app.module';
import { LedgerReconciliationService } from '../../src/modules/ledger/application/ledger-reconciliation.service';
import { CreateWalletUseCase } from '../../src/modules/wallets/application/create-wallet.use-case';
import { ProcessWagerTransactionUseCase } from '../../src/modules/wagering/application/process-wager-transaction.use-case';
import { Money } from '../../src/shared/domain/money';

describe('ledger reconciliation diagnostics', () => {
  let app: INestApplicationContext;
  let entityManager: EntityManager;
  let reconciliation: LedgerReconciliationService;

  beforeAll(async () => {
    app = await Test.createTestingModule({ imports: [AppModule] }).compile();
    entityManager = app.get(EntityManager);
    reconciliation = app.get(LedgerReconciliationService);
  });

  afterAll(async () => {
    await app.close();
  });

  test('returns a consistent internal report and classifies wallet posting divergence', async () => {
    const wallet = await app.get(CreateWalletUseCase).execute({ playerId: v7(), initialBalance: Money.of('10.00', 'USD') });
    const process = app.get(ProcessWagerTransactionUseCase);
    await process.execute({
      providerId: 'reconciliation-ledger',
      externalTransactionId: `bet-${v7()}`,
      idempotencyKey: `key-${v7()}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'reconciliation-ledger-round',
      gameId: 'reconciliation-ledger-game',
      kind: 'BET',
      money: { amount: '2.00', currency: 'USD' },
    });

    const consistent = await reconciliation.reconcileWallet(wallet.id);
    expect(consistent?.consistent).toBe(true);
    expect(consistent?.checkedJournals).toBe(2);
    expect(consistent?.checkedPostings).toBe(2);
    expect(consistent?.issues).toEqual([]);

    const accounts = await entityManager.getConnection().execute<{ wallet_account: string; system_account: string }[]>(
      `select
         (select id from ledger_accounts where account_key = ?) as wallet_account,
         (select id from ledger_accounts where account_key = 'game_stake:USD' limit 1) as system_account`,
      [`wallet:USD:${wallet.id}`],
    );
    const transactionId = v7();
    const journalId = v7();
    const now = new Date();
    await entityManager.getConnection().execute(
      `insert into wager_transactions (id, provider_id, external_transaction_id, wallet_id, player_id, kind, amount, currency, status)
       values (?, 'reconciliation-ledger-corrupt', ?, ?, ?, 'BET', 1.00, 'USD', 'PROCESSED')`,
      [transactionId, `external-${transactionId}`, wallet.id, wallet.playerId],
    );
    await entityManager.transactional(async (manager) => {
      const query = (sql: string, params: unknown[]) => manager.getConnection().execute(sql, params, 'all', manager.getTransactionContext());
      await query(
        `insert into ledger_journal_entries (id, transaction_id, effect_type, currency, policy_version, occurred_at)
         values (?, ?, 'BET', 'USD', 'ledger-v1', ?)`,
        [journalId, transactionId, now],
      );
      await query(
        `insert into ledger_postings (id, journal_entry_id, account_id, wallet_id, direction, amount, currency)
         values (?, ?, ?, ?, 'CREDIT', 1.00, 'USD'), (?, ?, ?, null, 'DEBIT', 1.00, 'USD')`,
        [v7(), journalId, accounts[0].wallet_account, wallet.id, v7(), journalId, accounts[0].system_account],
      );
    });

    const inconsistent = await reconciliation.reconcileWallet(wallet.id);
    expect(inconsistent?.consistent).toBe(false);
    expect(inconsistent?.issues).toContain('WALLET_POSTING_BALANCE_DIFFERENCE');
    expect(inconsistent?.walletPostingBalance).toBe('9.00');
  });
});

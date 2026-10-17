import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { v4, v7 } from 'uuid';

const { Client } = require('pg') as { Client: new (options: { connectionString: string }) => any };

const databaseUrl = process.env.DATABASE_URL ?? 'postgresql://wagering:wagering@127.0.0.1:15432/wagering';

describe('PostgreSQL double-entry ledger constraints', () => {
  let client: any;

  beforeAll(async () => {
    client = new Client({ connectionString: databaseUrl });
    await client.connect();
  });

  afterAll(async () => {
    await client.end();
  });

  test('accepts a balanced journal and rejects an unbalanced journal at commit', async () => {
    const walletId = v4();
    const transactionId = v4();
    const accountId = v4();
    let systemAccountId: string;
    const journalId = v7();
    const now = new Date();

    await client.query('begin');
    try {
      await client.query(
        `insert into wallets (id, player_id, currency) values ($1, $2, 'BRL')`,
        [walletId, v4()],
      );
      await client.query(
        `insert into wager_transactions (id, provider_id, external_transaction_id, wallet_id, player_id, kind, amount, currency, status)
         values ($1, 'ledger-constraints', $2, $3, $4, 'BET', 10.00, 'BRL', 'PROCESSED')`,
        [transactionId, `tx-${transactionId}`, walletId, v4()],
      );
      await client.query(
        `insert into ledger_accounts (id, account_key, account_type, currency, wallet_id, policy_version)
         values ($1, $2, 'WALLET', 'BRL', $3, 'ledger-v1')`,
        [accountId, `wallet:BRL:${walletId}`, walletId],
      );
      const existingSystemAccount = await client.query(
        `select id from ledger_accounts where account_key = 'game_stake:BRL' limit 1`,
      );
      systemAccountId = existingSystemAccount.rows[0]?.id ?? v4();
      if (!existingSystemAccount.rows[0]) {
        await client.query(
          `insert into ledger_accounts (id, account_key, account_type, currency, wallet_id, policy_version)
           values ($1, 'game_stake:BRL', 'GAME_STAKE', 'BRL', null, 'ledger-v1')`,
          [systemAccountId],
        );
      }
      await client.query(
        `insert into ledger_journal_entries (id, transaction_id, effect_type, currency, policy_version, occurred_at)
         values ($1, $2, 'BET', 'BRL', 'ledger-v1', $3)`,
        [journalId, transactionId, now],
      );
      await client.query(
        `insert into ledger_postings (id, journal_entry_id, account_id, wallet_id, direction, amount, currency)
         values ($1, $2, $3, $4, 'DEBIT', 10.00, 'BRL'), ($5, $2, $6, null, 'CREDIT', 10.00, 'BRL')`,
        [v7(), journalId, accountId, walletId, v7(), systemAccountId],
      );
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    }

    const unbalancedJournalId = v7();
    const unbalancedTransactionId = v4();
    await client.query('begin');
    try {
      await client.query(
        `insert into wager_transactions (id, provider_id, external_transaction_id, wallet_id, player_id, kind, amount, currency, status)
         values ($1, 'ledger-constraints', $2, $3, $4, 'BET', 10.00, 'BRL', 'PROCESSED')`,
        [unbalancedTransactionId, `tx-${unbalancedTransactionId}`, walletId, v4()],
      );
      await client.query(
        `insert into ledger_journal_entries (id, transaction_id, effect_type, currency, policy_version, occurred_at)
         values ($1, $2, 'BET', 'BRL', 'ledger-v1', $3)`,
        [unbalancedJournalId, unbalancedTransactionId, now],
      );
      await client.query(
        `insert into ledger_postings (id, journal_entry_id, account_id, wallet_id, direction, amount, currency)
         values ($1, $2, $3, $4, 'DEBIT', 10.00, 'BRL'), ($5, $2, $6, null, 'CREDIT', 9.99, 'BRL')`,
        [v7(), unbalancedJournalId, accountId, walletId, v7(), systemAccountId],
      );
      await expect(client.query('commit')).rejects.toThrow('not balanced');
    } finally {
      await client.query('rollback');
    }
  });

  test('rejects updates and deletes of ledger records', async () => {
    const row = await client.query('select id from ledger_journal_entries order by created_at desc limit 1');
    expect(row.rows).toHaveLength(1);

    await expect(client.query('update ledger_journal_entries set policy_version = policy_version where id = $1', [row.rows[0].id]))
      .rejects.toThrow('double-entry ledger records are immutable');
    await expect(client.query('delete from ledger_journal_entries where id = $1', [row.rows[0].id]))
      .rejects.toThrow('double-entry ledger records are immutable');
  });
});

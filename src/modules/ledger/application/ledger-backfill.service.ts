import { Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { v7 as uuidv7 } from 'uuid';

import { Money } from '../../../shared/domain/money';

export interface LedgerBackfillReport {
  scanned: number;
  converted: number;
  alreadyPresent: number;
  skipped: number;
}

interface LegacyLedgerRow {
  id: string;
  wallet_id: string;
  transaction_id: string;
  direction: 'DEBIT' | 'CREDIT';
  amount: string;
  currency: string;
  balance_before: string;
  balance_after: string;
  created_at: Date;
  transaction_kind: string;
  transaction_status: string;
  transaction_currency: string;
  wallet_currency: string;
}

@Injectable()
export class LedgerBackfillService {
  constructor(private readonly entityManager: EntityManager) {}

  async execute(): Promise<LedgerBackfillReport> {
    return this.entityManager.transactional(async (manager) => {
      const totalRows = await this.query<{ count: string }>(manager, `
        select count(*)::text as count from wallet_ledger_entries
      `);
      const rows = await this.query<LegacyLedgerRow>(manager, `
        select ledger.id,
               ledger.wallet_id,
               ledger.transaction_id,
               ledger.direction,
               ledger.amount,
               ledger.currency,
               ledger.balance_before,
               ledger.balance_after,
               ledger.created_at,
               transaction.kind as transaction_kind,
               transaction.status as transaction_status,
               transaction.currency as transaction_currency,
               wallet.currency as wallet_currency
          from wallet_ledger_entries ledger
          join wager_transactions transaction on transaction.id = ledger.transaction_id
          join wallets wallet on wallet.id = ledger.wallet_id
          left join ledger_journal_entries journal
            on journal.transaction_id = ledger.transaction_id
           and journal.effect_type = transaction.kind
         where journal.id is null
         order by ledger.created_at asc, ledger.id asc
      `);
      const scanned = Number(totalRows[0]?.count ?? 0);
      const report: LedgerBackfillReport = {
        scanned,
        converted: 0,
        alreadyPresent: Math.max(0, scanned - rows.length),
        skipped: 0,
      };

      for (const row of rows) {
        if (row.transaction_kind === 'LOSS' || row.transaction_status !== 'PROCESSED') {
          report.skipped += 1;
          continue;
        }
        this.assertConsistent(row);

        const currency = row.currency.toUpperCase();
        const walletAccountId = await this.ensureAccount(manager, {
          accountKey: `wallet:${currency}:${row.wallet_id}`,
          accountType: 'WALLET',
          currency,
          walletId: row.wallet_id,
        });
        const legacyAccountId = await this.ensureAccount(manager, {
          accountKey: `legacy_counterparty:${currency}`,
          accountType: 'LEGACY_COUNTERPARTY',
          currency,
        });

        const journalRows = await this.query<{ id: string }>(manager,
          `insert into ledger_journal_entries
             (id, transaction_id, effect_type, currency, policy_version, occurred_at, created_at)
           values (?, ?, ?, ?, 'legacy-v1', ?, ?)
           on conflict (transaction_id, effect_type) do nothing
           returning id`,
          [row.id, row.transaction_id, row.transaction_kind, currency, row.created_at, row.created_at],
        );
        const journalId = journalRows[0]?.id;
        if (!journalId) {
          report.alreadyPresent += 1;
          continue;
        }

        const counterpartyDirection = row.direction === 'DEBIT' ? 'CREDIT' : 'DEBIT';
        await this.query(manager,
          `insert into ledger_postings
             (id, journal_entry_id, account_id, wallet_id, direction, amount, currency, created_at)
           values (?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, null, ?, ?, ?, ?)`,
          [
            uuidv7(), journalId, walletAccountId, row.wallet_id, row.direction, row.amount, currency, row.created_at,
            uuidv7(), journalId, legacyAccountId, counterpartyDirection, row.amount, currency, row.created_at,
          ],
        );
        report.converted += 1;
      }

      return report;
    });
  }

  private async ensureAccount(
    manager: EntityManager,
    account: { accountKey: string; accountType: string; currency: string; walletId?: string },
  ): Promise<string> {
    const inserted = await this.query<{ id: string }>(manager,
      `insert into ledger_accounts
         (id, account_key, account_type, currency, wallet_id, policy_version)
       values (?, ?, ?, ?, ?, 'legacy-v1')
       on conflict (account_key) do nothing
       returning id`,
      [uuidv7(), account.accountKey, account.accountType, account.currency, account.walletId ?? null],
    );
    if (inserted[0]?.id) return inserted[0].id;

    const existing = await this.query<{ id: string }>(manager,
      `select id from ledger_accounts where account_key = ?`,
      [account.accountKey],
    );
    const accountId = existing[0]?.id;
    if (!accountId) throw new Error(`ledger account ${account.accountKey} was not created`);
    return accountId;
  }

  private async query<T>(manager: EntityManager, query: string, params: unknown[] = []): Promise<T[]> {
    const result = await manager.getConnection().execute(query, params, 'all', manager.getTransactionContext());
    return result as T[];
  }

  private assertConsistent(row: LegacyLedgerRow): void {
    const currency = row.currency.toUpperCase();
    if (currency !== row.transaction_currency.toUpperCase() || currency !== row.wallet_currency.toUpperCase()) {
      throw new Error(`ledger backfill blocked by currency divergence for entry ${row.id}`);
    }

    try {
      const amount = Money.of(row.amount, currency);
      const before = Money.of(row.balance_before, currency);
      const after = Money.of(row.balance_after, currency);
      const expected = row.direction === 'CREDIT' ? before.add(amount) : before.subtract(amount);
      if (!expected.equals(after)) throw new Error('balance transition mismatch');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'invalid ledger values';
      throw new Error(`ledger backfill blocked for entry ${row.id}: ${message}`);
    }
  }
}

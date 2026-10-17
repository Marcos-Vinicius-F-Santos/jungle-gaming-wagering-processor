import { Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import Decimal from 'decimal.js';

export const LEDGER_RECONCILIATION_ISSUES = [
  'JOURNAL_UNBALANCED',
  'JOURNAL_CURRENCY_MISMATCH',
  'POSTING_ACCOUNT_MISSING',
  'POSTING_ACCOUNT_MISMATCH',
  'POSTING_TRANSACTION_MISMATCH',
  'MISSING_JOURNAL',
  'WALLET_POSTING_BALANCE_DIFFERENCE',
] as const;
export type LedgerReconciliationIssue = (typeof LEDGER_RECONCILIATION_ISSUES)[number];

export interface LedgerReconciliationReport {
  readonly walletId: string;
  readonly currency: string;
  readonly storedBalance: string;
  readonly walletPostingBalance: string;
  readonly checkedJournals: number;
  readonly checkedPostings: number;
  readonly consistent: boolean;
  readonly issues: readonly LedgerReconciliationIssue[];
}

interface WalletRow {
  id: string;
  currency: string;
  balance_amount: string;
}

interface CountRow {
  count: string;
}

@Injectable()
export class LedgerReconciliationService {
  constructor(private readonly entityManager: EntityManager) {}

  async reconcileWallet(walletId: string): Promise<LedgerReconciliationReport | undefined> {
    return this.entityManager.transactional(async (manager) => {
      const wallets = await this.query<WalletRow>(manager, `
        select id, currency, balance_amount from wallets where id = ?
      `, [walletId]);
      const wallet = wallets[0];
      if (!wallet) return undefined;

      const [journalCount, postingCount, unbalanced, currencyMismatch, missingAccount, accountMismatch, transactionMismatch, missingJournal, walletNet] = await Promise.all([
        this.count(manager, `
          select count(distinct journal.id)::text as count
            from ledger_journal_entries journal
            join ledger_postings posting on posting.journal_entry_id = journal.id
           where exists (select 1 from ledger_postings wallet_posting where wallet_posting.journal_entry_id = journal.id and wallet_posting.wallet_id = ?)
        `, [walletId]),
        this.count(manager, `
          select count(posting.id)::text as count
            from ledger_postings posting
           where posting.wallet_id = ?
        `, [walletId]),
        this.count(manager, `
          select count(*)::text as count from (
            select journal.id
              from ledger_journal_entries journal
              join ledger_postings posting on posting.journal_entry_id = journal.id
             where exists (select 1 from ledger_postings wallet_posting where wallet_posting.journal_entry_id = journal.id and wallet_posting.wallet_id = ?)
             group by journal.id, journal.currency
            having count(posting.id) < 2
                or count(*) filter (where posting.direction = 'DEBIT') = 0
                or count(*) filter (where posting.direction = 'CREDIT') = 0
                or coalesce(sum(posting.amount) filter (where posting.direction = 'DEBIT'), 0)
                 <> coalesce(sum(posting.amount) filter (where posting.direction = 'CREDIT'), 0)
          ) invalid_journals
        `, [walletId]),
        this.count(manager, `
          select count(*)::text as count
            from ledger_journal_entries journal
            join ledger_postings posting on posting.journal_entry_id = journal.id
           where exists (select 1 from ledger_postings wallet_posting where wallet_posting.journal_entry_id = journal.id and wallet_posting.wallet_id = ?)
             and (journal.currency <> posting.currency or posting.currency <> ?)
        `, [walletId, wallet.currency]),
        this.count(manager, `
          select count(*)::text as count
            from ledger_postings posting
            left join ledger_accounts account on account.id = posting.account_id
           where posting.wallet_id = ? and account.id is null
        `, [walletId]),
        this.count(manager, `
          select count(*)::text as count
            from ledger_postings posting
            join ledger_accounts account on account.id = posting.account_id
           where posting.wallet_id = ?
             and (posting.currency <> account.currency or posting.wallet_id is distinct from account.wallet_id)
        `, [walletId]),
        this.count(manager, `
          select count(*)::text as count
            from ledger_journal_entries journal
            join ledger_postings posting on posting.journal_entry_id = journal.id
            join wager_transactions transaction on transaction.id = journal.transaction_id
           where posting.wallet_id = ?
             and (transaction.wallet_id <> posting.wallet_id or transaction.currency <> journal.currency)
        `, [walletId]),
        this.count(manager, `
          select count(*)::text as count
            from wallet_ledger_entries ledger
            join wager_transactions transaction on transaction.id = ledger.transaction_id
           where ledger.wallet_id = ?
             and transaction.kind <> 'LOSS'
             and transaction.status = 'PROCESSED'
             and not exists (
               select 1 from ledger_journal_entries journal
                where journal.transaction_id = ledger.transaction_id
                  and journal.effect_type = transaction.kind
             )
        `, [walletId]),
        this.query<{ net: string | null }>(manager, `
          select coalesce(sum(case when direction = 'CREDIT' then amount else -amount end), 0)::text as net
            from ledger_postings
           where wallet_id = ?
        `, [walletId]),
      ]);

      const walletPostingBalance = new Decimal(walletNet[0]?.net ?? '0').toFixed(2);
      const issues: LedgerReconciliationIssue[] = [];
      if (unbalanced > 0) issues.push('JOURNAL_UNBALANCED');
      if (currencyMismatch > 0) issues.push('JOURNAL_CURRENCY_MISMATCH');
      if (missingAccount > 0) issues.push('POSTING_ACCOUNT_MISSING');
      if (accountMismatch > 0) issues.push('POSTING_ACCOUNT_MISMATCH');
      if (transactionMismatch > 0) issues.push('POSTING_TRANSACTION_MISMATCH');
      if (missingJournal > 0) issues.push('MISSING_JOURNAL');
      if (walletPostingBalance !== new Decimal(wallet.balance_amount).toFixed(2)) {
        issues.push('WALLET_POSTING_BALANCE_DIFFERENCE');
      }

      return {
        walletId: wallet.id,
        currency: wallet.currency,
        storedBalance: new Decimal(wallet.balance_amount).toFixed(2),
        walletPostingBalance,
        checkedJournals: journalCount,
        checkedPostings: postingCount,
        consistent: issues.length === 0,
        issues: Object.freeze(issues),
      };
    }, { readOnly: true });
  }

  private async count(manager: EntityManager, query: string, params: unknown[]): Promise<number> {
    const rows = await this.query<CountRow>(manager, query, params);
    return Number(rows[0]?.count ?? 0);
  }

  private async query<T>(manager: EntityManager, query: string, params: unknown[] = []): Promise<T[]> {
    const result = await manager.getConnection().execute(query, params, 'all', manager.getTransactionContext());
    return result as T[];
  }
}

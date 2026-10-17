import type { LedgerAccount } from '../../domain/ledger-account';
import type { JournalEntry } from '../../domain/journal-entry';

export interface DoubleEntryLedgerRepository {
  saveAccount(account: LedgerAccount): Promise<void>;
  saveJournal(journal: JournalEntry): Promise<void>;
  findAccountByKey(accountKey: string): Promise<LedgerAccount | undefined>;
  findAccountById(accountId: string): Promise<LedgerAccount | undefined>;
  findJournalById(journalId: string): Promise<JournalEntry | undefined>;
  findJournalByTransactionEffect(transactionId: string, effectType: string): Promise<JournalEntry | undefined>;
}

export const DOUBLE_ENTRY_LEDGER_REPOSITORY = Symbol('DOUBLE_ENTRY_LEDGER_REPOSITORY');

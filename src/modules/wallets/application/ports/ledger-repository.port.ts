export interface LedgerRepository<TLedgerEntry = unknown> {
  save(entry: TLedgerEntry): Promise<void>;
  findByWalletId(walletId: string): Promise<readonly TLedgerEntry[]>;
}

export const LEDGER_REPOSITORY = Symbol('LEDGER_REPOSITORY');

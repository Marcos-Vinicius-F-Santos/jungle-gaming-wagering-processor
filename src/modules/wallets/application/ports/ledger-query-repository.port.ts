export interface LedgerEntryReadModel {
  readonly id: string;
  readonly transactionId: string;
  readonly walletId: string;
  readonly direction: 'DEBIT' | 'CREDIT';
  readonly amount: string;
  readonly currency: string;
  readonly balanceBefore: string;
  readonly balanceAfter: string;
  readonly createdAt: Date;
}

export interface LedgerCursor {
  readonly walletId: string;
  readonly createdAt: Date;
  readonly id: string;
}

export interface LedgerPage {
  readonly items: readonly LedgerEntryReadModel[];
  readonly hasNextPage: boolean;
}

export interface LedgerQueryRepository {
  findPage(walletId: string, cursor: LedgerCursor | undefined, limit: number): Promise<LedgerPage>;
}

export const LEDGER_QUERY_REPOSITORY = Symbol('LEDGER_QUERY_REPOSITORY');

import type { ReconciliationIssueCode } from '../reconciliation-issue-code';

export interface ReconciliationLedgerEntrySnapshot {
  readonly id: string;
  readonly direction: 'CREDIT' | 'DEBIT';
  readonly amount: string;
  readonly currency: string;
  readonly balanceBefore: string;
  readonly balanceAfter: string;
  readonly createdAt: Date;
}

export interface ReconciliationSnapshot {
  readonly walletId: string;
  readonly currency: string;
  readonly storedBalance: string;
  readonly entries: readonly ReconciliationLedgerEntrySnapshot[];
}

export interface ReconciliationResult {
  readonly walletId: string;
  readonly storedBalance: { readonly amount: string; readonly currency: string };
  readonly calculatedBalance: { readonly amount: string; readonly currency: string };
  readonly difference: { readonly amount: string; readonly currency: string };
  readonly consistent: boolean;
  readonly checkedEntries: number;
  readonly issues: readonly ReconciliationIssueCode[];
}

export interface ReconciliationQueryRepository {
  findSnapshot(walletId: string): Promise<ReconciliationSnapshot | null>;
}

export const RECONCILIATION_QUERY_REPOSITORY = Symbol('RECONCILIATION_QUERY_REPOSITORY');

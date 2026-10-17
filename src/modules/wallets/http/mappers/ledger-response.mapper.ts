import type { LedgerEntryReadModel } from '../../application/ports/ledger-query-repository.port';

export interface LedgerEntryResponse {
  readonly id: string;
  readonly transactionId: string;
  readonly walletId: string;
  readonly direction: 'DEBIT' | 'CREDIT';
  readonly amount: string;
  readonly currency: string;
  readonly balanceBefore: string;
  readonly balanceAfter: string;
  readonly createdAt: string;
}

export function toLedgerEntryResponse(entry: LedgerEntryReadModel): LedgerEntryResponse {
  return {
    id: entry.id,
    transactionId: entry.transactionId,
    walletId: entry.walletId,
    direction: entry.direction,
    amount: entry.amount,
    currency: entry.currency,
    balanceBefore: entry.balanceBefore,
    balanceAfter: entry.balanceAfter,
    createdAt: entry.createdAt.toISOString(),
  };
}

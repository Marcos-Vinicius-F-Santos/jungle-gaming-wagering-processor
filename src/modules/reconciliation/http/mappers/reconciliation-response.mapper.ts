import type { ReconciliationResult } from '../../application/ports/reconciliation-query-repository.port';
import type { ReconciliationIssueCode } from '../../application/reconciliation-issue-code';

export interface ReconciliationResponse {
  readonly walletId: string;
  readonly storedBalance: { readonly amount: string; readonly currency: string };
  readonly calculatedBalance: { readonly amount: string; readonly currency: string };
  readonly difference: { readonly amount: string; readonly currency: string };
  readonly consistent: boolean;
  readonly checkedEntries: number;
  readonly issues: readonly ReconciliationIssueCode[];
}

export function toReconciliationResponse(result: ReconciliationResult): ReconciliationResponse {
  return {
    walletId: result.walletId,
    storedBalance: { ...result.storedBalance },
    calculatedBalance: { ...result.calculatedBalance },
    difference: { ...result.difference },
    consistent: result.consistent,
    checkedEntries: result.checkedEntries,
    issues: [...result.issues],
  };
}

import { describe, expect, test } from 'bun:test';

import {
  RECONCILIATION_ISSUE_CODES,
  type ReconciliationIssueCode,
} from '../../src/modules/reconciliation/application/reconciliation-issue-code';
import type {
  ReconciliationQueryRepository,
  ReconciliationResult,
  ReconciliationSnapshot,
} from '../../src/modules/reconciliation/application/ports/reconciliation-query-repository.port';

describe('reconciliation contracts', () => {
  test('represent an immutable raw snapshot and signed result without write-only fields', () => {
    const snapshot: ReconciliationSnapshot = Object.freeze({
      walletId: '018f0000-0000-7000-8000-000000000001',
      currency: 'BRL',
      storedBalance: '975.00',
      entries: Object.freeze([]),
    });
    const result: ReconciliationResult = Object.freeze({
      walletId: snapshot.walletId,
      storedBalance: { amount: '975.00', currency: 'BRL' },
      calculatedBalance: { amount: '950.00', currency: 'BRL' },
      difference: { amount: '-25.00', currency: 'BRL' },
      consistent: false,
      checkedEntries: 0,
      issues: ['BALANCE_DIFFERENCE'] as const,
    });
    const repository: ReconciliationQueryRepository = {
      async findSnapshot(walletId) {
        return walletId === snapshot.walletId ? snapshot : null;
      },
    };

    const issue: ReconciliationIssueCode = RECONCILIATION_ISSUE_CODES[0];
    expect(repository).toBeDefined();
    expect(result.difference.amount).toBe('-25.00');
    expect(result.issues).toEqual([issue]);
    expect(RECONCILIATION_ISSUE_CODES).toHaveLength(6);
  });
});

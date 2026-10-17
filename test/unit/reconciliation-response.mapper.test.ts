import { describe, expect, test } from 'bun:test';

import { toReconciliationResponse } from '../../src/modules/reconciliation/http/mappers/reconciliation-response.mapper';
import type { ReconciliationResult } from '../../src/modules/reconciliation/application/ports/reconciliation-query-repository.port';

describe('reconciliation response mapper', () => {
  test('maps signed difference and does not expose mutable source arrays', () => {
    const issues = ['BALANCE_DIFFERENCE'] as const;
    const result: ReconciliationResult = {
      walletId: '018f0000-0000-7000-8000-000000000001',
      storedBalance: { amount: '100.00', currency: 'BRL' },
      calculatedBalance: { amount: '75.00', currency: 'BRL' },
      difference: { amount: '-25.00', currency: 'BRL' },
      consistent: false,
      checkedEntries: 1,
      issues,
    };

    const response = toReconciliationResponse(result);

    expect(response).toEqual({ ...result });
    expect(response.difference.amount).toBe('-25.00');
    expect(response.issues).not.toBe(issues);
  });
});

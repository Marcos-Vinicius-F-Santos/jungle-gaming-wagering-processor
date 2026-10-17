import { describe, expect, test } from 'bun:test';

import { ReconciliationCalculator } from '../../src/modules/reconciliation/application/reconciliation-calculator';
import type {
  ReconciliationLedgerEntrySnapshot,
  ReconciliationSnapshot,
} from '../../src/modules/reconciliation/application/ports/reconciliation-query-repository.port';

const calculator = new ReconciliationCalculator();

function snapshot(storedBalance: string, entries: ReconciliationLedgerEntrySnapshot[]): ReconciliationSnapshot {
  return {
    walletId: '018f0000-0000-7000-8000-000000000001',
    currency: 'BRL',
    storedBalance,
    entries,
  };
}

function credit(amount: string, before: string, after: string, id = '018f0000-0000-7000-8000-000000000002'):
  ReconciliationLedgerEntrySnapshot {
  return {
    id,
    direction: 'CREDIT',
    amount,
    currency: 'BRL',
    balanceBefore: before,
    balanceAfter: after,
    createdAt: new Date('2026-10-16T12:00:00.000Z'),
  };
}

describe('ReconciliationCalculator', () => {
  test('reconstructs a consistent balance from credits and debits', () => {
    const result = calculator.calculate(snapshot('95.00', [
      credit('100.00', '0.00', '100.00'),
      {
        id: '018f0000-0000-7000-8000-000000000003',
        direction: 'DEBIT',
        amount: '5.00',
        currency: 'BRL',
        balanceBefore: '100.00',
        balanceAfter: '95.00',
        createdAt: new Date('2026-10-16T12:00:01.000Z'),
      },
    ]));

    expect(result).toEqual({
      walletId: '018f0000-0000-7000-8000-000000000001',
      storedBalance: { amount: '95.00', currency: 'BRL' },
      calculatedBalance: { amount: '95.00', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 2,
      issues: [],
    });
  });

  test('preserves an exact signed difference and counts an empty ledger', () => {
    const result = calculator.calculate(snapshot('25.00', []));

    expect(result.calculatedBalance).toEqual({ amount: '0.00', currency: 'BRL' });
    expect(result.difference).toEqual({ amount: '-25.00', currency: 'BRL' });
    expect(result.consistent).toBe(false);
    expect(result.checkedEntries).toBe(0);
    expect(result.issues).toEqual(['BALANCE_DIFFERENCE']);
  });

  test('classifies an arithmetically unbalanced entry', () => {
    const result = calculator.calculate(snapshot('100.00', [credit('100.00', '0.00', '90.00')]));

    expect(result.consistent).toBe(false);
    expect(result.issues).toEqual(['LEDGER_ENTRY_UNBALANCED']);
  });

  test('classifies a broken chain and invalid initial balance', () => {
    const result = calculator.calculate(snapshot('125.00', [
      credit('100.00', '25.00', '125.00'),
      credit('25.00', '100.00', '125.00', '018f0000-0000-7000-8000-000000000003'),
    ]));

    expect(result.issues).toEqual(['LEDGER_CHAIN_BROKEN', 'LEDGER_INITIAL_BALANCE_INVALID']);
  });

  test('classifies negative balances and a currency mismatch', () => {
    const result = calculator.calculate(snapshot('0.00', [{
      id: '018f0000-0000-7000-8000-000000000002',
      direction: 'DEBIT',
      amount: '10.00',
      currency: 'USD',
      balanceBefore: '-5.00',
      balanceAfter: '-15.00',
      createdAt: new Date('2026-10-16T12:00:00.000Z'),
    }]));

    expect(result.issues).toEqual([
      'BALANCE_DIFFERENCE',
      'LEDGER_INITIAL_BALANCE_INVALID',
      'LEDGER_NEGATIVE_BALANCE',
      'LEDGER_CURRENCY_MISMATCH',
    ]);
  });
});

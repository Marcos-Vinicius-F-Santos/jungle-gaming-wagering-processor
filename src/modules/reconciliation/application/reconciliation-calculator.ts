import Decimal from 'decimal.js';

import type {
  ReconciliationLedgerEntrySnapshot,
  ReconciliationResult,
  ReconciliationSnapshot,
} from './ports/reconciliation-query-repository.port';
import {
  RECONCILIATION_ISSUE_CODES,
  type ReconciliationIssueCode,
} from './reconciliation-issue-code';

export class ReconciliationCalculator {
  calculate(snapshot: ReconciliationSnapshot): ReconciliationResult {
    const issues = new Set<ReconciliationIssueCode>();
    const storedBalance = decimal(snapshot.storedBalance, 'stored balance');
    let calculatedBalance = new Decimal(0);
    let previousBalanceAfter: Decimal | undefined;

    for (const [index, entry] of snapshot.entries.entries()) {
      this.validateEntry(entry, snapshot.currency, index, issues);

      const amount = decimal(entry.amount, `entry ${entry.id} amount`);
      const balanceBefore = decimal(entry.balanceBefore, `entry ${entry.id} balance before`);
      const balanceAfter = decimal(entry.balanceAfter, `entry ${entry.id} balance after`);

      if (index === 0 && !balanceBefore.isZero()) {
        issues.add('LEDGER_INITIAL_BALANCE_INVALID');
      }

      if (previousBalanceAfter && !previousBalanceAfter.eq(balanceBefore)) {
        issues.add('LEDGER_CHAIN_BROKEN');
      }

      const expectedBalanceAfter = entry.direction === 'CREDIT'
        ? balanceBefore.plus(amount)
        : balanceBefore.minus(amount);
      if (!expectedBalanceAfter.eq(balanceAfter)) {
        issues.add('LEDGER_ENTRY_UNBALANCED');
      }

      if (balanceBefore.isNegative() || balanceAfter.isNegative()) {
        issues.add('LEDGER_NEGATIVE_BALANCE');
      }

      calculatedBalance = entry.direction === 'CREDIT'
        ? calculatedBalance.plus(amount)
        : calculatedBalance.minus(amount);
      previousBalanceAfter = balanceAfter;
    }

    const difference = calculatedBalance.minus(storedBalance);
    if (!difference.isZero()) {
      issues.add('BALANCE_DIFFERENCE');
    }

    const orderedIssues = RECONCILIATION_ISSUE_CODES.filter((code) => issues.has(code));
    const currency = snapshot.currency;
    return {
      walletId: snapshot.walletId,
      storedBalance: { amount: storedBalance.toFixed(2), currency },
      calculatedBalance: { amount: calculatedBalance.toFixed(2), currency },
      difference: { amount: difference.toFixed(2), currency },
      consistent: orderedIssues.length === 0,
      checkedEntries: snapshot.entries.length,
      issues: Object.freeze(orderedIssues),
    };
  }

  private validateEntry(
    entry: ReconciliationLedgerEntrySnapshot,
    walletCurrency: string,
    index: number,
    issues: Set<ReconciliationIssueCode>,
  ): void {
    if (entry.currency !== walletCurrency) {
      issues.add('LEDGER_CURRENCY_MISMATCH');
    }

    const amount = decimal(entry.amount, `entry ${entry.id} amount`);
    const balanceBefore = decimal(entry.balanceBefore, `entry ${entry.id} balance before`);
    const balanceAfter = decimal(entry.balanceAfter, `entry ${entry.id} balance after`);

    if (amount.isNegative() || amount.isZero()) {
      issues.add('LEDGER_ENTRY_UNBALANCED');
    }

    if (balanceBefore.isNegative() || balanceAfter.isNegative()) {
      issues.add('LEDGER_NEGATIVE_BALANCE');
    }

    if (index === 0 && !balanceBefore.isZero()) {
      issues.add('LEDGER_INITIAL_BALANCE_INVALID');
    }
  }
}

function decimal(value: string, field: string): Decimal {
  try {
    return new Decimal(value);
  } catch {
    throw new Error(`invalid reconciliation snapshot field: ${field}`);
  }
}

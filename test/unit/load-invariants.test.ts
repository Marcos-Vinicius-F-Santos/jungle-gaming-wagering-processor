import { describe, expect, test } from 'bun:test';
import { validateLoadInvariants, waitForDrain } from '../load/load-invariants';

describe('load invariants', () => {
  test('accepts equivalent decimal balances and a drained queue', () => {
    const result = validateLoadInvariants({
      wallets: [{ walletId: 'wallet-1', balance: '010.00', reconstructedBalance: '10', financialEffectDuplicates: 0 }],
      inboxConflicts: 0,
      outboxFinancialDuplicates: 0,
      unexpectedDeadLetters: 0,
      queueDrained: true,
    });

    expect(result.passed).toBe(true);
    expect(result.walletsChecked).toBe(1);
    expect(result.balanceLedgerMismatches).toBe(0);
  });

  test('reports every blocking invariant violation', () => {
    const result = validateLoadInvariants({
      wallets: [{ walletId: 'wallet-1', balance: '-1.00', reconstructedBalance: '0.00', financialEffectDuplicates: 2 }],
      inboxConflicts: 1,
      outboxFinancialDuplicates: 1,
      unexpectedDeadLetters: 1,
      queueDrained: false,
    });

    expect(result.passed).toBe(false);
    expect(result.balanceLedgerMismatches).toBe(1);
    expect(result.negativeBalances).toBe(1);
    expect(result.duplicateFinancialEffects).toBe(2);
    expect(result.details.length).toBe(7);
  });

  test('waits until messages and outbox are drained', async () => {
    let reads = 0;
    const final = await waitForDrain(async () => {
      reads += 1;
      return reads < 3
        ? { pendingMessages: 1, pendingOutbox: 1, deadLetterMessages: 0 }
        : { pendingMessages: 0, pendingOutbox: 0, deadLetterMessages: 0 };
    }, 100, 1);

    expect(reads).toBe(3);
    expect(final.pendingMessages).toBe(0);
  });
});

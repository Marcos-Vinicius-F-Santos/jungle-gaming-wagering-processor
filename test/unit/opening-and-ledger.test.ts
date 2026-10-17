import { describe, expect, test } from 'bun:test';
import { v4, v7 } from 'uuid';

import { WalletLedgerEntry } from '../../src/modules/wallets/domain/wallet-ledger-entry';
import { WagerTransaction } from '../../src/modules/wagering/domain/wager-transaction';
import { Money } from '../../src/shared/domain/money';

describe('OPENING and wallet ledger', () => {
  const now = new Date('2026-10-15T20:00:00.000Z');

  test('creates a processed OPENING for a positive initial balance', () => {
    const walletId = v7();
    const transaction = WagerTransaction.opening(v7(), walletId, v4(), Money.of('100.00', 'BRL'), now);

    expect(transaction.kind).toBe('OPENING');
    expect(transaction.status).toBe('PROCESSED');
    expect(transaction.externalTransactionId).toBe(`opening:${walletId}`);
  });

  test('does not allow an OPENING with zero balance', () => {
    expect(() => WagerTransaction.opening(v7(), v7(), v4(), Money.of('0.00', 'BRL'), now)).toThrow();
  });

  test('creates a balanced immutable credit entry', () => {
    const entry = WalletLedgerEntry.credit(
      v7(),
      v7(),
      v7(),
      Money.of('100.00', 'BRL'),
      Money.of('0.00', 'BRL'),
      now,
    );

    expect(entry.direction).toBe('CREDIT');
    expect(entry.balanceBefore.amount).toBe('0.00');
    expect(entry.balanceAfter.amount).toBe('100.00');
  });

  test('rejects zero ledger entries and prevents negative debits', () => {
    expect(() => WalletLedgerEntry.credit(v7(), v7(), v7(), Money.of('0.00', 'BRL'), Money.of('0.00', 'BRL'), now)).toThrow();
    expect(() => WalletLedgerEntry.debit(v7(), v7(), v7(), Money.of('2.00', 'BRL'), Money.of('1.00', 'BRL'), now)).toThrow();
  });
});

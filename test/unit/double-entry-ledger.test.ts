import { describe, expect, test } from 'bun:test';
import { v4, v7 } from 'uuid';

import { LedgerAccount } from '../../src/modules/ledger/domain/ledger-account';
import { JournalEntry } from '../../src/modules/ledger/domain/journal-entry';
import { Posting } from '../../src/modules/ledger/domain/posting';
import { Money } from '../../src/shared/domain/money';

describe('double-entry ledger domain', () => {
  const now = new Date('2026-10-16T20:00:00.000Z');

  test('creates immutable wallet and system accounts', () => {
    const walletId = v4();
    const wallet = LedgerAccount.create({
      accountKey: `wallet:${walletId}:BRL`,
      accountType: 'WALLET',
      currency: 'brl',
      walletId,
      policyVersion: 'ledger-v1',
      createdAt: now,
    });
    const system = LedgerAccount.create({
      accountKey: 'house-funding:BRL',
      accountType: 'HOUSE_FUNDING',
      currency: 'BRL',
      policyVersion: 'ledger-v1',
      createdAt: now,
    });

    expect(wallet.currency).toBe('BRL');
    expect(wallet.walletId).toBe(walletId);
    expect(system.walletId).toBeUndefined();
    expect(wallet.createdAt).not.toBe(now);
  });

  test('creates a balanced journal and returns defensive snapshots', () => {
    const journalId = v7();
    const transactionId = v7();
    const account = v7();
    const walletAccount = v7();
    const postings = [
      Posting.create({ id: v7(), journalEntryId: journalId, accountId: account, direction: 'DEBIT', money: Money.of('100.00', 'BRL'), createdAt: now }),
      Posting.create({ id: v7(), journalEntryId: journalId, accountId: walletAccount, direction: 'CREDIT', money: Money.of('100.00', 'BRL'), createdAt: now }),
    ];
    const journal = JournalEntry.create({ id: journalId, transactionId, effectType: 'OPENING', currency: 'BRL', policyVersion: 'ledger-v1', occurredAt: now, postings });
    const snapshot = journal.toSnapshot();

    expect(journal.isBalanced()).toBe(true);
    expect(journal.postings).toHaveLength(2);
    expect(snapshot.postings).not.toBe(journal.toSnapshot().postings);
    expect(journal.postings[0]).not.toBe(postings[0]);
  });

  test('rejects invalid account, posting and journal combinations', () => {
    expect(() => LedgerAccount.create({ accountKey: 'wallet:BRL', accountType: 'WALLET', currency: 'BRL', policyVersion: 'ledger-v1', createdAt: now })).toThrow('walletId');
    expect(() => Posting.create({ id: v7(), journalEntryId: v7(), accountId: v4(), direction: 'DEBIT', money: Money.of('0.00', 'BRL'), createdAt: now })).toThrow('positive');

    const journalId = v7();
    const base = { id: v7(), journalEntryId: journalId, accountId: v7(), direction: 'DEBIT' as const, money: Money.of('10.00', 'BRL'), createdAt: now };
    expect(() => JournalEntry.create({ id: journalId, transactionId: v7(), effectType: 'BET', currency: 'BRL', policyVersion: 'ledger-v1', occurredAt: now, postings: [base] })).toThrow('at least two');
    expect(() => JournalEntry.create({ id: journalId, transactionId: v7(), effectType: 'BET', currency: 'BRL', policyVersion: 'ledger-v1', occurredAt: now, postings: [
      base,
      { ...base, id: v7(), direction: 'CREDIT', money: Money.of('9.00', 'BRL') },
    ] })).toThrow('balance');
    expect(() => JournalEntry.create({ id: journalId, transactionId: v7(), effectType: 'BET', currency: 'BRL', policyVersion: 'ledger-v1', occurredAt: now, postings: [
      base,
      { ...base, id: v7(), direction: 'CREDIT', money: Money.of('10.00', 'USD') },
    ] })).toThrow('one currency');
  });
});

import { describe, expect, test } from 'bun:test';

import { Money } from '../../src/shared/domain/money';
import {
  DEFAULT_LEDGER_POLICY_VERSION,
  LedgerAccountPolicy,
  type LedgerPostingInstruction,
} from '../../src/modules/ledger/domain/ledger-policy';

describe('ledger account policy', () => {
  const amount = Money.of('10.00', 'brl');
  const walletId = 'wallet-01';

  test('maps financial effects to deterministic wallet and system accounts', () => {
    const opening = LedgerAccountPolicy.createPlan({ effectType: 'OPENING', walletId, currency: 'brl', amount });
    const bet = LedgerAccountPolicy.createPlan({ effectType: 'BET', walletId, currency: 'BRL', amount });
    const win = LedgerAccountPolicy.createPlan({ effectType: 'WIN', walletId, currency: 'BRL', amount });

    expect(opening.policyVersion).toBe(DEFAULT_LEDGER_POLICY_VERSION);
    expect(opening.postings.map((posting) => [posting.direction, posting.account.accountKey])).toEqual([
      ['DEBIT', 'house_funding:BRL'],
      ['CREDIT', 'wallet:BRL:wallet-01'],
    ]);
    expect(bet.postings.map((posting) => posting.account.accountType)).toEqual(['GAME_STAKE', 'WALLET']);
    expect(bet.postings.map((posting) => posting.direction)).toEqual(['CREDIT', 'DEBIT']);
    expect(win.postings.map((posting) => posting.account.accountType)).toEqual(['GAME_PAYOUT', 'WALLET']);
    expect(win.postings.map((posting) => posting.direction)).toEqual(['DEBIT', 'CREDIT']);
  });

  test('creates REFUND and ROLLBACK by exact inversion of referenced postings', () => {
    const bet = LedgerAccountPolicy.createPlan({ effectType: 'BET', walletId, currency: 'BRL', amount });
    const reference: readonly LedgerPostingInstruction[] = bet.postings;
    const refund = LedgerAccountPolicy.createPlan({
      effectType: 'REFUND',
      walletId,
      currency: 'BRL',
      amount,
      policyVersion: 'ledger-v2',
      reference: { effectType: 'BET', journalEntryId: 'journal-01', postings: reference },
    });
    const rollback = LedgerAccountPolicy.createPlan({
      effectType: 'ROLLBACK',
      walletId,
      currency: 'BRL',
      amount,
      reference: { effectType: 'BET', journalEntryId: 'journal-01', postings: reference },
    });

    expect(refund.policyVersion).toBe('ledger-v2');
    expect(refund.reversalOfJournalEntryId).toBe('journal-01');
    expect(refund.postings.map((posting) => [posting.direction, posting.account.accountKey, posting.money.amount])).toEqual([
      ['DEBIT', 'game_stake:BRL', '10.00'],
      ['CREDIT', 'wallet:BRL:wallet-01', '10.00'],
    ]);
    expect(rollback.postings).toEqual(refund.postings);
  });

  test('does not create a patrimonial journal for LOSS and rejects invalid reversals', () => {
    const loss = LedgerAccountPolicy.createPlan({ effectType: 'LOSS', walletId, currency: 'BRL', amount });

    expect(loss.patrimonial).toBe(false);
    expect(loss.postings).toEqual([]);
    expect(() => LedgerAccountPolicy.createPlan({ effectType: 'REFUND', walletId, currency: 'BRL', amount })).toThrow('referenced journal');
    expect(() => LedgerAccountPolicy.createPlan({
      effectType: 'ROLLBACK',
      walletId,
      currency: 'BRL',
      amount: Money.of('9.99', 'BRL'),
      reference: { effectType: 'BET', postings: LedgerAccountPolicy.createPlan({ effectType: 'BET', walletId, currency: 'BRL', amount }).postings },
    })).toThrow('must match');
  });
});

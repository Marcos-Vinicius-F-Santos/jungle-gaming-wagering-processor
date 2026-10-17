import { describe, expect, test } from 'bun:test';
import { v4 } from 'uuid';

import { WagerReferenceValidator } from '../../src/modules/wagering/application/wager-reference.validator';
import type { WagerTransactionRecord } from '../../src/modules/wagering/application/ports/wager-transaction-repository.port';

const context = {
  providerId: 'provider-a',
  playerId: v4(),
  walletId: v4(),
  currency: 'BRL',
  roundId: 'round-a',
};

function bet(overrides: Partial<WagerTransactionRecord> = {}): WagerTransactionRecord {
  return {
    id: v4(),
    providerId: context.providerId,
    externalTransactionId: 'bet-a',
    idempotencyKey: 'key-a',
    payloadHash: 'hash-a',
    walletId: context.walletId,
    playerId: context.playerId,
    roundId: context.roundId,
    gameId: 'game-a',
    kind: 'BET',
    amount: '25.00',
    currency: context.currency,
    status: 'PROCESSED',
    failureCode: null,
    resultBalanceAmount: '75.00',
    resultBalanceCurrency: context.currency,
    createdAt: new Date('2026-10-15T20:00:00.000Z'),
    processedAt: new Date('2026-10-15T20:00:01.000Z'),
    ...overrides,
  };
}

describe('WagerReferenceValidator', () => {
  const validator = new WagerReferenceValidator();

  test('accepts a processed BET from the same provider, player, wallet, currency and round', () => {
    const result = validator.validate(bet(), context);

    expect(result.status).toBe('VALID');
  });

  test('distinguishes an absent reference from an incompatible one', () => {
    expect(validator.validate(null, context)).toEqual({ status: 'NOT_FOUND' });
    expect(validator.validate(bet({ kind: 'WIN' }), context)).toEqual({
      status: 'INCOMPATIBLE',
      reason: 'NOT_PROCESSED_BET',
    });
    expect(validator.validate(bet({ walletId: v4() }), context)).toEqual({
      status: 'INCOMPATIBLE',
      reason: 'CONTEXT_MISMATCH',
    });
  });

  test('keeps a compatible non-terminal reference pending', () => {
    const result = validator.validate(bet({ status: 'PENDING', processedAt: null }), context);

    expect(result).toEqual({
      status: 'PENDING',
      transaction: expect.objectContaining({ status: 'PENDING' }),
    });
  });

  test('allows REFUND only for BET and ROLLBACK for BET, WIN or REFUND with the full amount', () => {
    expect(validator.validate(bet({ amount: '25.00' }), { ...context, kind: 'REFUND', amount: '25.00' }).status)
      .toBe('VALID');
    expect(validator.validate(bet({ amount: '25.00' }), { ...context, kind: 'ROLLBACK', amount: '25.00' }).status)
      .toBe('VALID');
    expect(validator.validate(bet({ kind: 'WIN' }), { ...context, kind: 'REFUND', amount: '25.00' })).toEqual({
      status: 'INCOMPATIBLE',
      reason: 'NOT_ALLOWED_KIND',
    });
    expect(validator.validate(bet({ amount: '10.00' }), { ...context, kind: 'ROLLBACK', amount: '25.00' })).toEqual({
      status: 'INCOMPATIBLE',
      reason: 'AMOUNT_MISMATCH',
    });
    expect(validator.validate(bet({ kind: 'REFUND' }), { ...context, kind: 'ROLLBACK', amount: '25.00' }).status)
      .toBe('VALID');
  });
});

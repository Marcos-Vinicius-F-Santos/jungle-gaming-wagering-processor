import { describe, expect, test } from 'bun:test';
import { v4, v7 } from 'uuid';

import { WagerTransaction } from '../../src/modules/wagering/domain/wager-transaction';
import { Money } from '../../src/shared/domain/money';

describe('WagerTransaction domain', () => {
  const now = new Date('2026-10-15T20:00:00.000Z');

  function createBet(): WagerTransaction {
    return WagerTransaction.create({
      id: v7(),
      providerId: 'provider-a',
      externalTransactionId: 'external-a',
      idempotencyKey: 'key-a',
      payloadHash: 'hash-a',
      walletId: v4(),
      playerId: v4(),
      roundId: 'round-a',
      gameId: 'game-a',
      kind: 'BET',
      money: Money.of('25.00', 'BRL'),
      createdAt: now,
    });
  }

  test('creates a pending BET with its audit fields and debit direction', () => {
    const transaction = createBet();

    expect(transaction.kind).toBe('BET');
    expect(transaction.status).toBe('PENDING');
    expect(transaction.idempotencyKey).toBe('key-a');
    expect(transaction.payloadHash).toBe('hash-a');
    expect(transaction.ledgerDirectionFor()).toBe('DEBIT');
    expect(transaction.matchesPayload('hash-a')).toBe(true);
  });

  test('keeps an optional reference as part of the transaction snapshot', () => {
    const transaction = WagerTransaction.create({
      id: v7(),
      providerId: 'provider-a',
      externalTransactionId: 'win-a',
      idempotencyKey: 'key-win-a',
      payloadHash: 'hash-win-a',
      walletId: v4(),
      playerId: v4(),
      roundId: 'round-a',
      gameId: 'game-a',
      kind: 'WIN',
      referenceExternalTransactionId: 'bet-a',
      money: Money.of('25.00', 'BRL'),
      createdAt: now,
    });

    expect(transaction.referenceExternalTransactionId).toBe('bet-a');
    expect(transaction.pendingAttempts).toBe(0);
  });

  test('links a resolved internal reference and derives rollback direction', () => {
    const transaction = WagerTransaction.create({
      id: v7(),
      providerId: 'provider-a',
      externalTransactionId: 'rollback-a',
      idempotencyKey: 'key-rollback-a',
      payloadHash: 'hash-rollback-a',
      walletId: v4(),
      playerId: v4(),
      roundId: 'round-a',
      gameId: 'game-a',
      kind: 'ROLLBACK',
      referenceExternalTransactionId: 'win-a',
      money: Money.of('25.00', 'BRL'),
      createdAt: now,
    });

    const referenceId = v7();
    transaction.linkReference(referenceId);
    expect(transaction.referenceTransactionId).toBe(referenceId);
    expect(transaction.ledgerDirectionFor('WIN')).toBe('DEBIT');
    expect(() => transaction.linkReference(v7())).toThrow('reference cannot be changed');
  });

  test('supports terminal processed and rejected states but prevents reapplication', () => {
    const processed = createBet();
    processed.markProcessed(now, Money.of('75.00', 'BRL'));

    expect(processed.status).toBe('PROCESSED');
    expect(processed.isTerminal()).toBe(true);
    expect(processed.resultBalance?.toJSON()).toEqual({ amount: '75.00', currency: 'BRL' });
    expect(() => processed.reject('INSUFFICIENT_FUNDS')).toThrow('terminal wager transaction cannot change state');

    const rejected = createBet();
    rejected.reject('INSUFFICIENT_FUNDS', Money.of('10.00', 'BRL'));

    expect(rejected.status).toBe('REJECTED');
    expect(rejected.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect(rejected.isTerminal()).toBe(true);
  });

  test('rejects invalid processed balance currency and non-positive wagers', () => {
    expect(() => createBet().markProcessed(now, Money.of('75.00', 'USD'))).toThrow(
      'result balance currency must match transaction currency',
    );
    expect(() => WagerTransaction.create({
      id: v7(),
      providerId: 'provider-a',
      externalTransactionId: 'external-a',
      idempotencyKey: 'key-a',
      payloadHash: 'hash-a',
      walletId: v4(),
      playerId: v4(),
      roundId: 'round-a',
      gameId: 'game-a',
      kind: 'BET',
      money: Money.of('0.00', 'BRL'),
      createdAt: now,
    })).toThrow('wager transaction amount must be positive');
  });

  test('tracks pending reference retries and expires with a stable failure code', () => {
    const transaction = WagerTransaction.create({
      id: v7(),
      providerId: 'provider-a',
      externalTransactionId: 'win-pending',
      idempotencyKey: 'key-pending',
      payloadHash: 'hash-pending',
      walletId: v4(),
      playerId: v4(),
      roundId: 'round-a',
      gameId: 'game-a',
      kind: 'WIN',
      referenceExternalTransactionId: 'bet-missing',
      money: Money.of('80.00', 'BRL'),
      createdAt: now,
    });
    const nextAttempt = new Date(now.getTime() + 30_000);

    transaction.markPendingReference(now, nextAttempt);
    expect(transaction.status).toBe('PENDING_REFERENCE');
    expect(transaction.pendingSince).toEqual(now);
    expect(transaction.pendingAttempts).toBe(0);

    transaction.scheduleReferenceRetry(new Date(now.getTime() + 90_000));
    expect(transaction.pendingAttempts).toBe(1);
    transaction.expirePendingReference();

    expect(transaction.status).toBe('REJECTED');
    expect(transaction.failureCode).toBe('REFERENCE_NOT_FOUND');
    expect(transaction.pendingSince).toBeUndefined();
  });
});

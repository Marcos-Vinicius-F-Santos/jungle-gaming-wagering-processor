import { describe, expect, test } from 'bun:test';
import { v4, v7 } from 'uuid';

import { Money } from '../../src/shared/domain/money';
import { Wallet } from '../../src/modules/wallets/domain/wallet';

describe('Wallet', () => {
  const now = new Date('2026-10-15T20:00:00.000Z');

  test('opens with version one and the supplied initial balance', () => {
    const wallet = Wallet.open(v7(), v4(), Money.of('1000.00', 'BRL'), now);

    expect(wallet.version).toBe(1);
    expect(wallet.balance.toJSON()).toEqual({ amount: '1000.00', currency: 'BRL' });
    expect(wallet.createdAt.toISOString()).toBe(now.toISOString());
    expect(wallet.updatedAt.toISOString()).toBe(now.toISOString());
  });

  test('opens a zero-balance wallet without creating financial side effects', () => {
    const wallet = Wallet.open(v7(), v4(), Money.of('0.00', 'USD'), now);

    expect(wallet.balance.isZero()).toBe(true);
  });

  test('rehydrates a valid persisted snapshot without exposing mutable dates', () => {
    const createdAt = new Date(now);
    const wallet = Wallet.rehydrate({
      id: v7(),
      playerId: v4(),
      balance: Money.of('10.00', 'USD'),
      version: 3,
      createdAt,
      updatedAt: new Date(now.getTime() + 1000),
    });

    createdAt.setFullYear(2000);
    expect(wallet.createdAt.getUTCFullYear()).toBe(2026);
    expect(wallet.version).toBe(3);
  });

  test('rejects non-UUIDv7 wallet ids, invalid players and invalid versions', () => {
    expect(() => Wallet.open(v4(), v4(), Money.of('1.00', 'USD'), now)).toThrow();
    expect(() => Wallet.open(v7(), 'not-a-uuid', Money.of('1.00', 'USD'), now)).toThrow();
    expect(() => Wallet.rehydrate({
      id: v7(),
      playerId: v4(),
      balance: Money.of('1.00', 'USD'),
      version: 0,
      createdAt: now,
      updatedAt: now,
    })).toThrow();
  });

  test('credits with exact money and advances the version once', () => {
    const wallet = Wallet.open(v7(), v4(), Money.of('100.00', 'BRL'), now);

    const result = wallet.credit(Money.of('80.00', 'BRL'), new Date(now.getTime() + 1000));

    expect(result).toEqual({
      balanceBefore: Money.of('100.00', 'BRL'),
      balanceAfter: Money.of('180.00', 'BRL'),
      versionBefore: 1,
      versionAfter: 2,
    });
    expect(wallet.balance.toJSON()).toEqual({ amount: '180.00', currency: 'BRL' });
    expect(wallet.version).toBe(2);
    expect(wallet.updatedAt.toISOString()).toBe('2026-10-15T20:00:01.000Z');
  });

  test('rejects credit with a different currency or non-positive amount', () => {
    const wallet = Wallet.open(v7(), v4(), Money.of('100.00', 'BRL'), now);

    expect(() => wallet.credit(Money.of('1.00', 'USD'), now)).toThrow('wallet credit currency');
    expect(() => wallet.credit(Money.of('0.00', 'BRL'), now)).toThrow('wallet credit amount');
    expect(wallet.version).toBe(1);
    expect(wallet.balance.toJSON()).toEqual({ amount: '100.00', currency: 'BRL' });
  });
});

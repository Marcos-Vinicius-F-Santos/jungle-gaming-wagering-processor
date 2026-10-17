import { describe, expect, test } from 'bun:test';

import { Money } from '../../src/shared/domain/money';

describe('Money', () => {
  test('normalizes a valid amount and currency without using floating point', () => {
    expect(Money.of('1000', 'brl').toJSON()).toEqual({ amount: '1000.00', currency: 'BRL' });
    expect(Money.of('0.5', 'USD').amount).toBe('0.50');
  });

  test('preserves exact decimal arithmetic', () => {
    const total = Money.of('0.10', 'USD').add(Money.of('0.20', 'USD'));

    expect(total.amount).toBe('0.30');
  });

  test('rejects malformed, negative, scientific and over-precision amounts', () => {
    for (const amount of ['', 'NaN', 'Infinity', '1e2', '1.001', '-1.00']) {
      expect(() => Money.of(amount, 'USD')).toThrow();
    }
  });

  test('rejects invalid currencies and mismatched arithmetic', () => {
    expect(() => Money.of('1.00', 'XYZ')).toThrow();
    expect(() => Money.of('1.00', 'US')).toThrow();
    expect(() => Money.of('1.00', 'USD').add(Money.of('1.00', 'BRL'))).toThrow();
  });

  test('rejects subtraction that would make the balance negative', () => {
    expect(() => Money.of('1.00', 'USD').subtract(Money.of('2.00', 'USD'))).toThrow();
  });
});

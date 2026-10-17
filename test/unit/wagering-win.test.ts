import { describe, expect, test } from 'bun:test';
import { v4, v7 } from 'uuid';

import { ProcessWagerTransactionUseCase } from '../../src/modules/wagering/application/process-wager-transaction.use-case';
import { Money } from '../../src/shared/domain/money';
import { Wallet } from '../../src/modules/wallets/domain/wallet';

describe('WIN processing', () => {
  test('credits the wallet and creates one CREDIT ledger entry', async () => {
    const now = new Date('2026-10-15T20:00:00.000Z');
    const wallet = Wallet.open(v7(), v4(), Money.of('100.00', 'BRL'), now);
    const savedTransactions: unknown[] = [];
    const savedLedgers: unknown[] = [];
    let nextId = 0;
    const useCase = new ProcessWagerTransactionUseCase(
      { findById: async () => wallet, updateBalanceIfVersion: async () => true } as never,
      {
        findByIdempotencyKey: async () => null,
        findByExternalTransactionId: async () => null,
        save: async (transaction: unknown) => { savedTransactions.push(transaction); },
      } as never,
      { save: async (entry: unknown) => { savedLedgers.push(entry); } } as never,
      { execute: async <T>(work: () => Promise<T>) => work() } as never,
      { now: () => now } as never,
      { next: () => (++nextId === 1 ? v7() : v7()) } as never,
      { hash: () => 'hash-win' } as never,
      { info: () => undefined, warn: () => undefined, error: () => undefined } as never,
    );

    const result = await useCase.execute({
      providerId: 'provider-a',
      externalTransactionId: 'win-a',
      idempotencyKey: 'key-win-a',
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-a',
      gameId: 'game-a',
      kind: 'WIN',
      money: { amount: '80.00', currency: 'BRL' },
    });

    expect(result).toEqual({
      transactionId: expect.any(String),
      status: 'PROCESSED',
      balance: { amount: '180.00', currency: 'BRL' },
      idempotentReplay: false,
    });
    expect(wallet.version).toBe(2);
    expect(savedTransactions).toHaveLength(1);
    expect(savedLedgers).toHaveLength(1);
    expect(savedLedgers[0]).toMatchObject({
      direction: 'CREDIT',
      amount: Money.of('80.00', 'BRL'),
      balanceBefore: Money.of('100.00', 'BRL'),
      balanceAfter: Money.of('180.00', 'BRL'),
    });
  });
});

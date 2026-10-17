import { describe, expect, test } from 'bun:test';
import { v4, v7 } from 'uuid';

import { ProcessWagerTransactionUseCase } from '../../src/modules/wagering/application/process-wager-transaction.use-case';
import type { WagerTransactionRecord } from '../../src/modules/wagering/application/ports/wager-transaction-repository.port';
import { Money } from '../../src/shared/domain/money';
import { Wallet } from '../../src/modules/wallets/domain/wallet';

function createUseCase(wallet: Wallet, reference: WagerTransactionRecord | null, events: unknown[]) {
  return new ProcessWagerTransactionUseCase(
    { findById: async () => wallet, updateBalanceIfVersion: async () => true } as never,
    {
      findByIdempotencyKey: async () => null,
      findByExternalTransactionId: async (_providerId: string, externalTransactionId: string) =>
        externalTransactionId === reference?.externalTransactionId ? reference : null,
      save: async () => undefined,
      update: async () => undefined,
      findPendingReferenceDue: async () => [],
    } as never,
    { save: async () => undefined } as never,
    { execute: async <T>(work: () => Promise<T>) => work() } as never,
    { now: () => new Date('2026-10-15T20:00:00.000Z') } as never,
    { next: () => v7() } as never,
    { hash: () => 'hash' } as never,
    { info: () => undefined, warn: () => undefined, error: () => undefined } as never,
    { enqueue: async (event: unknown) => { events.push(event); } } as never,
  );
}

describe('WIN reference flow', () => {
  test('persists a missing reference as PENDING_REFERENCE and enqueues its event', async () => {
    const now = new Date('2026-10-15T20:00:00.000Z');
    const wallet = Wallet.open(v7(), v4(), Money.of('100.00', 'BRL'), now);
    const events: unknown[] = [];
    const result = await createUseCase(wallet, null, events).execute({
      providerId: 'provider-a',
      externalTransactionId: 'win-a',
      idempotencyKey: 'key-a',
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-a',
      gameId: 'game-a',
      kind: 'WIN',
      referenceExternalTransactionId: 'bet-missing',
      money: { amount: '80.00', currency: 'BRL' },
    });

    expect(result.status).toBe('PENDING_REFERENCE');
    expect(wallet.version).toBe(1);
    expect(events).toHaveLength(1);
    expect((events[0] as { eventType: string }).eventType).toBe('WagerTransactionPendingReference');
  });

  test('keeps a compatible non-terminal reference pending without changing the wallet', async () => {
    const now = new Date('2026-10-15T20:00:00.000Z');
    const wallet = Wallet.open(v7(), v4(), Money.of('100.00', 'BRL'), now);
    const events: unknown[] = [];
    const reference: WagerTransactionRecord = {
      id: v7(),
      providerId: 'provider-a',
      externalTransactionId: 'bet-pending',
      idempotencyKey: 'bet-key',
      payloadHash: 'bet-hash',
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: 'round-a',
      gameId: 'game-a',
      referenceExternalTransactionId: null,
      referenceTransactionId: null,
      pendingSince: now,
      nextAttemptAt: new Date(now.getTime() + 30_000),
      pendingAttempts: 0,
      kind: 'BET',
      amount: '25.00',
      currency: 'BRL',
      status: 'PENDING',
      failureCode: null,
      resultBalanceAmount: null,
      resultBalanceCurrency: null,
      createdAt: now,
      processedAt: null,
    };
    const result = await createUseCase(wallet, reference, events).execute({
      providerId: 'provider-a',
      externalTransactionId: 'win-b',
      idempotencyKey: 'key-b',
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-a',
      gameId: 'game-a',
      kind: 'WIN',
      referenceExternalTransactionId: reference.externalTransactionId,
      money: { amount: '80.00', currency: 'BRL' },
    });

    expect(result.status).toBe('PENDING_REFERENCE');
    expect(wallet.version).toBe(1);
    expect(events).toHaveLength(1);
  });
});

import { describe, expect, test } from 'bun:test';
import { v4, v7 } from 'uuid';

import { ProcessWagerTransactionUseCase } from '../../src/modules/wagering/application/process-wager-transaction.use-case';
import type { WagerTransactionRecord } from '../../src/modules/wagering/application/ports/wager-transaction-repository.port';
import { ReversalConflictError } from '../../src/modules/wagering/application/errors/reversal-conflict.error';
import { Money } from '../../src/shared/domain/money';
import { Wallet } from '../../src/modules/wallets/domain/wallet';

function reference(wallet: Wallet, kind: 'BET' | 'WIN' | 'REFUND' | 'ROLLBACK', amount = '25.00'): WagerTransactionRecord {
  return {
    id: v7(),
    providerId: 'provider-a',
    externalTransactionId: `${kind.toLowerCase()}-reference`,
    idempotencyKey: `key-${kind.toLowerCase()}`,
    payloadHash: 'reference-hash',
    walletId: wallet.id,
    playerId: wallet.playerId,
    roundId: 'round-a',
    gameId: 'game-a',
    referenceExternalTransactionId: kind === 'REFUND' ? 'bet-reference' : null,
    referenceTransactionId: null,
    pendingSince: null,
    nextAttemptAt: null,
    pendingAttempts: 0,
    kind,
    amount,
    currency: 'BRL',
    status: 'PROCESSED',
    failureCode: null,
    resultBalanceAmount: '100.00',
    resultBalanceCurrency: 'BRL',
    createdAt: new Date('2026-10-15T20:00:00.000Z'),
    processedAt: new Date('2026-10-15T20:00:01.000Z'),
  };
}

function createUseCase(
  wallet: Wallet,
  referenceRecord: WagerTransactionRecord | null,
  existingReversal: WagerTransactionRecord | null = null,
) {
  const saved: unknown[] = [];
  const ledger: unknown[] = [];
  const events: unknown[] = [];
  const useCase = new ProcessWagerTransactionUseCase(
    { findById: async () => wallet, updateBalanceIfVersion: async () => true } as never,
    {
      findByIdempotencyKey: async () => null,
      findByExternalTransactionId: async (_providerId: string, externalTransactionId: string) =>
        externalTransactionId === referenceRecord?.externalTransactionId ? referenceRecord : null,
      findDirectReversal: async () => existingReversal,
      save: async (transaction: unknown) => { saved.push(transaction); },
      update: async (transaction: unknown) => { saved.push(transaction); },
      findPendingReferenceDue: async () => [],
    } as never,
    { save: async (entry: unknown) => { ledger.push(entry); } } as never,
    { execute: async <T>(work: () => Promise<T>) => work() } as never,
    { now: () => new Date('2026-10-15T20:00:00.000Z') } as never,
    { next: () => v7() } as never,
    { hash: () => 'hash' } as never,
    { info: () => undefined, warn: () => undefined, error: () => undefined } as never,
    { enqueue: async (event: unknown) => { events.push(event); } } as never,
  );
  return { useCase, ledger, events, saved };
}

function command(wallet: Wallet, kind: 'REFUND' | 'ROLLBACK', externalTransactionId: string, referenceExternalTransactionId: string) {
  return {
    providerId: 'provider-a',
    externalTransactionId,
    idempotencyKey: `key-${externalTransactionId}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-a',
    gameId: 'game-a',
    kind,
    referenceExternalTransactionId,
    money: { amount: '25.00', currency: 'BRL' },
  } as const;
}

describe('REFUND and ROLLBACK processing', () => {
  test('credits a processed BET through REFUND and creates one CREDIT ledger entry', async () => {
    const wallet = Wallet.open(v7(), v4(), Money.of('75.00', 'BRL'), new Date('2026-10-15T20:00:00.000Z'));
    const { useCase, ledger, events } = createUseCase(wallet, reference(wallet, 'BET'));
    const result = await useCase.execute(command(wallet, 'REFUND', 'refund-a', 'bet-reference'));

    expect(result).toMatchObject({ status: 'PROCESSED', balance: { amount: '100.00', currency: 'BRL' } });
    expect(ledger).toHaveLength(1);
    expect((ledger[0] as { direction: string }).direction).toBe('CREDIT');
    expect(events).toHaveLength(2);
  });

  test('debits a processed WIN through ROLLBACK', async () => {
    const wallet = Wallet.open(v7(), v4(), Money.of('75.00', 'BRL'), new Date('2026-10-15T20:00:00.000Z'));
    const { useCase, ledger } = createUseCase(wallet, reference(wallet, 'WIN'));
    const result = await useCase.execute(command(wallet, 'ROLLBACK', 'rollback-a', 'win-reference'));

    expect(result).toMatchObject({ status: 'PROCESSED', balance: { amount: '50.00', currency: 'BRL' } });
    expect((ledger[0] as { direction: string }).direction).toBe('DEBIT');
  });

  test('rejects a rollback that would make the balance negative without a ledger entry', async () => {
    const wallet = Wallet.open(v7(), v4(), Money.of('75.00', 'BRL'), new Date('2026-10-15T20:00:00.000Z'));
    const { useCase, ledger, events } = createUseCase(wallet, reference(wallet, 'WIN', '100.00'));
    const result = await useCase.execute({
      ...command(wallet, 'ROLLBACK', 'rollback-negative', 'win-reference'),
      money: { amount: '100.00', currency: 'BRL' },
    });

    expect(result).toMatchObject({ status: 'REJECTED', failureCode: 'REVERSAL_NEGATIVE_BALANCE' });
    expect(ledger).toHaveLength(0);
    expect(events).toHaveLength(1);
  });

  test('rejects a second direct reversal of the same reference', async () => {
    const wallet = Wallet.open(v7(), v4(), Money.of('75.00', 'BRL'), new Date('2026-10-15T20:00:00.000Z'));
    const original = reference(wallet, 'BET');
    const { useCase } = createUseCase(wallet, original, reference(wallet, 'REFUND'));

    await expect(useCase.execute(command(wallet, 'ROLLBACK', 'rollback-conflict', original.externalTransactionId)))
      .rejects.toBeInstanceOf(ReversalConflictError);
  });

  test('reprocesses a pending ROLLBACK through the same financial effect', async () => {
    const wallet = Wallet.open(v7(), v4(), Money.of('75.00', 'BRL'), new Date('2026-10-15T20:00:00.000Z'));
    const original = reference(wallet, 'WIN');
    const pending = {
      ...reference(wallet, 'ROLLBACK'),
      id: v7(),
      externalTransactionId: 'rollback-pending',
      idempotencyKey: 'key-rollback-pending',
      payloadHash: 'pending-hash',
      referenceExternalTransactionId: original.externalTransactionId,
      status: 'PENDING_REFERENCE',
      pendingSince: new Date('2026-10-15T20:00:00.000Z'),
      nextAttemptAt: new Date('2026-10-15T20:01:00.000Z'),
      pendingAttempts: 0,
      resultBalanceAmount: null,
      resultBalanceCurrency: null,
      processedAt: null,
    } satisfies WagerTransactionRecord;
    const { useCase, ledger } = createUseCase(wallet, original);

    const result = await useCase.reprocessPendingReference(pending);

    expect(result).toMatchObject({ status: 'PROCESSED', balance: { amount: '50.00', currency: 'BRL' } });
    expect((ledger[0] as { direction: string }).direction).toBe('DEBIT');
  });
});

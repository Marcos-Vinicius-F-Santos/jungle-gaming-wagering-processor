import { describe, expect, test } from 'bun:test';
import { v4 } from 'uuid';

import { CanonicalPayloadHasher } from '../../src/modules/wagering/application/canonical-payload-hasher';
import { ExternalTransactionConflictError } from '../../src/modules/wagering/application/errors/external-transaction-conflict.error';
import { IdempotencyConflictError } from '../../src/modules/wagering/application/errors/idempotency-conflict.error';
import { ProcessWagerTransactionUseCase } from '../../src/modules/wagering/application/process-wager-transaction.use-case';
import type { WagerTransactionRecord } from '../../src/modules/wagering/application/ports/wager-transaction-repository.port';
import type { Metrics } from '../../src/shared/application/ports/metrics.port';
import { InMemoryMetrics } from '../../src/shared/infrastructure/metrics/in-memory-metrics';

const command = {
  providerId: 'provider-a',
  externalTransactionId: 'external-a',
  idempotencyKey: 'key-a',
  playerId: v4(),
  walletId: v4(),
  roundId: 'round-a',
  gameId: 'game-a',
  kind: 'BET' as const,
  money: { amount: '25.00', currency: 'BRL' },
};

function record(overrides: Partial<WagerTransactionRecord> = {}): WagerTransactionRecord {
  return {
    id: v4(),
    providerId: command.providerId,
    externalTransactionId: command.externalTransactionId,
    idempotencyKey: command.idempotencyKey,
    payloadHash: null,
    walletId: command.walletId,
    playerId: command.playerId,
    roundId: command.roundId,
    gameId: command.gameId,
    kind: 'BET',
    amount: '25.00',
    currency: 'BRL',
    status: 'PROCESSED',
    failureCode: null,
    resultBalanceAmount: '75.00',
    resultBalanceCurrency: 'BRL',
    createdAt: new Date('2026-10-15T20:00:00.000Z'),
    processedAt: new Date('2026-10-15T20:00:01.000Z'),
    ...overrides,
  };
}

function useCase(
  existingByKey: WagerTransactionRecord | null,
  existingByExternal: WagerTransactionRecord | null,
  metrics?: Metrics,
) {
  return new ProcessWagerTransactionUseCase(
    { findById: async () => null, updateBalanceIfVersion: async () => false } as never,
    {
      findByIdempotencyKey: async () => existingByKey,
      findByExternalTransactionId: async () => existingByExternal,
      save: async () => undefined,
    } as never,
    { save: async () => undefined } as never,
    { execute: async <T>(work: () => Promise<T>) => work() } as never,
    { now: () => new Date('2026-10-15T20:00:00.000Z') } as never,
    { next: () => v4() } as never,
    new CanonicalPayloadHasher(),
    { info: () => undefined, warn: () => undefined, error: () => undefined } as never,
    undefined,
    metrics,
  );
}

describe('BET idempotency and conflicts', () => {
  const hash = new CanonicalPayloadHasher().hash({
    providerId: command.providerId,
    externalTransactionId: command.externalTransactionId,
    playerId: command.playerId,
    walletId: command.walletId,
    roundId: command.roundId,
    gameId: command.gameId,
    kind: command.kind,
    money: command.money,
  });

  test('replays the persisted result without invoking financial ports', async () => {
    const transaction = record({ payloadHash: hash });
    const metrics = new InMemoryMetrics();
    const result = await useCase(transaction, null, metrics).execute(command);

    expect(result).toEqual({
      transactionId: transaction.id,
      status: 'PROCESSED',
      balance: { amount: '75.00', currency: 'BRL' },
      idempotentReplay: true,
    });
    expect(metrics.snapshot().get('wager_transactions_total{kind=BET,source=HTTP,status=PROCESSED}')).toBe(1);
    expect(metrics.snapshot().get('wager_replays_total{kind=BET,source=HTTP}')).toBe(1);
    expect(metrics.observationsSnapshot().get('processing_duration_ms{operation=WAGER_BET,source=HTTP}')?.length).toBe(1);
  });

  test('rejects a changed payload for the same idempotency key', async () => {
    const transaction = record({ payloadHash: 'different-hash' });

    await expect(useCase(transaction, null).execute(command)).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  test('rejects a changed payload for the same external transaction', async () => {
    const transaction = record({ payloadHash: 'different-hash' });

    await expect(useCase(null, transaction).execute({ ...command, idempotencyKey: 'other-key' }))
      .rejects.toBeInstanceOf(ExternalTransactionConflictError);
  });

  test.each([
    ['WIN', { amount: '80.00', currency: 'BRL' }],
    ['LOSS', { amount: '80.00', currency: 'BRL' }],
  ] as const)('replays a processed %s without invoking financial ports', async (kind, money) => {
    const transactionCommand = { ...command, kind, money };
    const payloadHash = new CanonicalPayloadHasher().hash({
      providerId: transactionCommand.providerId,
      externalTransactionId: transactionCommand.externalTransactionId,
      playerId: transactionCommand.playerId,
      walletId: transactionCommand.walletId,
      roundId: transactionCommand.roundId,
      gameId: transactionCommand.gameId,
      kind: transactionCommand.kind,
      money: transactionCommand.money,
    });
    const transaction = record({
      kind,
      amount: money.amount,
      payloadHash,
    });

    const result = await useCase(transaction, null).execute(transactionCommand);

    expect(result).toEqual({
      transactionId: transaction.id,
      status: 'PROCESSED',
      balance: { amount: '75.00', currency: 'BRL' },
      idempotentReplay: true,
    });
  });
});

import { describe, expect, test } from 'bun:test';

import { InvalidTransactionIdentifierError } from '../../src/modules/wagering/application/errors/invalid-transaction-identifier.error';
import { TransactionNotFoundError } from '../../src/modules/wagering/application/errors/transaction-not-found.error';
import { GetWagerTransactionUseCase } from '../../src/modules/wagering/application/get-wager-transaction.use-case';
import type {
  WagerTransactionQueryRepository,
  WagerTransactionReadModel,
} from '../../src/modules/wagering/application/ports/wager-transaction-query-repository.port';

const transactionId = '018f0000-0000-7000-8000-000000000001';
const transaction: WagerTransactionReadModel = {
  id: transactionId,
  providerId: 'provider-a',
  externalTransactionId: 'external-a',
  walletId: '018f0000-0000-7000-8000-000000000002',
  playerId: '018f0000-0000-7000-8000-000000000003',
  roundId: 'round-a',
  gameId: 'game-a',
  referenceExternalTransactionId: null,
  referenceTransactionId: null,
  pendingSince: null,
  nextAttemptAt: null,
  pendingAttempts: 0,
  kind: 'BET',
  amount: '25.00',
  currency: 'BRL',
  status: 'PROCESSED',
  failureCode: null,
  resultBalanceAmount: '75.00',
  resultBalanceCurrency: 'BRL',
  createdAt: new Date('2026-10-16T12:00:00.000Z'),
  processedAt: new Date('2026-10-16T12:00:00.010Z'),
};

describe('GetWagerTransactionUseCase', () => {
  test('returns the same read model by ID and provider/external identity', async () => {
    const query: WagerTransactionQueryRepository = {
      findById: async (id) => id === transactionId ? transaction : null,
      findByProviderExternalId: async (providerId, externalId) =>
        providerId === transaction.providerId && externalId === transaction.externalTransactionId
          ? transaction
          : null,
    };
    const useCase = new GetWagerTransactionUseCase(query);

    expect(await useCase.executeById(transactionId)).toBe(transaction);
    expect(await useCase.executeByProviderExternalId('provider-a', 'external-a')).toBe(transaction);
  });

  test('maps missing records, including an incorrect provider, to not found', async () => {
    const query: WagerTransactionQueryRepository = {
      findById: async () => null,
      findByProviderExternalId: async () => null,
    };
    const useCase = new GetWagerTransactionUseCase(query);

    await expect(useCase.executeById(transactionId)).rejects.toBeInstanceOf(TransactionNotFoundError);
    await expect(useCase.executeByProviderExternalId('other-provider', 'external-a'))
      .rejects.toBeInstanceOf(TransactionNotFoundError);
  });

  test('rejects invalid identifiers before querying', async () => {
    let calls = 0;
    const query: WagerTransactionQueryRepository = {
      findById: async () => {
        calls += 1;
        return transaction;
      },
      findByProviderExternalId: async () => {
        calls += 1;
        return transaction;
      },
    };
    const useCase = new GetWagerTransactionUseCase(query);

    await expect(useCase.executeById('not-a-uuid')).rejects.toBeInstanceOf(InvalidTransactionIdentifierError);
    await expect(useCase.executeByProviderExternalId('provider\n', 'external-a'))
      .rejects.toBeInstanceOf(InvalidTransactionIdentifierError);
    expect(calls).toBe(0);
  });
});

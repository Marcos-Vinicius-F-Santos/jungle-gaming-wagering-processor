import { describe, expect, test } from 'bun:test';
import { BadRequestException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { v4 } from 'uuid';

import { InvalidTransactionIdentifierError } from '../../src/modules/wagering/application/errors/invalid-transaction-identifier.error';
import { TransactionNotFoundError } from '../../src/modules/wagering/application/errors/transaction-not-found.error';
import type { GetWagerTransactionUseCase } from '../../src/modules/wagering/application/get-wager-transaction.use-case';
import type { WagerTransactionReadModel } from '../../src/modules/wagering/application/ports/wager-transaction-query-repository.port';
import { WageringTransactionQueryController } from '../../src/modules/wagering/http/wagering-transaction-query.controller';

const transaction: WagerTransactionReadModel = {
  id: v4(),
  providerId: 'provider-a',
  externalTransactionId: 'external-a',
  walletId: v4(),
  playerId: v4(),
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

describe('WageringTransactionQueryController', () => {
  test('returns the safe read model for both public lookup paths', async () => {
    const useCase = {
      executeById: async () => transaction,
      executeByProviderExternalId: async () => transaction,
    } as unknown as GetWagerTransactionUseCase;
    const queryController = new WageringTransactionQueryController(useCase);

    const byId = await queryController.byId(transaction.id);
    const byExternal = await queryController.byProviderExternalId('provider-a', 'external-a');

    expect(byId).toEqual(byExternal);
    expect(byId.resultBalance).toEqual({ amount: '75.00', currency: 'BRL' });
    expect('payloadHash' in byId).toBe(false);
    expect('idempotencyKey' in byId).toBe(false);
  });

  test('maps invalid input, not found and infrastructure failures safely', async () => {
    await expect(new WageringTransactionQueryController({
      executeById: async () => { throw new InvalidTransactionIdentifierError(); },
    } as unknown as GetWagerTransactionUseCase).byId(transaction.id)).rejects.toBeInstanceOf(BadRequestException);
    await expect(new WageringTransactionQueryController({
      executeByProviderExternalId: async () => { throw new TransactionNotFoundError(); },
    } as unknown as GetWagerTransactionUseCase).byProviderExternalId('provider-a', 'external-a'))
      .rejects.toBeInstanceOf(NotFoundException);
    await expect(new WageringTransactionQueryController({
      executeById: async () => { throw new Error('database details'); },
    } as unknown as GetWagerTransactionUseCase).byId(transaction.id)).rejects
      .toBeInstanceOf(ServiceUnavailableException);
  });
});

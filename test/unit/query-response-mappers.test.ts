import { describe, expect, test } from 'bun:test';

import { toLedgerEntryResponse } from '../../src/modules/wallets/http/mappers/ledger-response.mapper';
import { toWagerTransactionResponse } from '../../src/modules/wagering/http/mappers/wager-transaction-response.mapper';
import type { LedgerEntryReadModel } from '../../src/modules/wallets/application/ports/ledger-query-repository.port';
import type { WagerTransactionReadModel } from '../../src/modules/wagering/application/ports/wager-transaction-query-repository.port';

describe('query response mappers', () => {
  test('serializes ledger money as strings and timestamps as UTC ISO', () => {
    const response = toLedgerEntryResponse({
      id: 'ledger-id',
      transactionId: 'transaction-id',
      walletId: 'wallet-id',
      direction: 'DEBIT',
      amount: '25.00',
      currency: 'BRL',
      balanceBefore: '100.00',
      balanceAfter: '75.00',
      createdAt: new Date('2026-10-16T12:00:00-03:00'),
    } satisfies LedgerEntryReadModel);

    expect(response.amount).toBe('25.00');
    expect(response.balanceAfter).toBe('75.00');
    expect(response.createdAt).toBe('2026-10-16T15:00:00.000Z');
  });

  test('maps optional transaction fields and omits write-only fields', () => {
    const response = toWagerTransactionResponse({
      id: 'transaction-id',
      providerId: 'provider-a',
      externalTransactionId: 'external-a',
      walletId: 'wallet-id',
      playerId: 'player-id',
      roundId: null,
      gameId: null,
      referenceExternalTransactionId: null,
      referenceTransactionId: null,
      pendingSince: new Date('2026-10-16T12:00:00.000Z'),
      nextAttemptAt: new Date('2026-10-16T12:01:00.000Z'),
      pendingAttempts: 2,
      kind: 'WIN',
      amount: '25.00',
      currency: 'BRL',
      status: 'PENDING_REFERENCE',
      failureCode: null,
      resultBalanceAmount: null,
      resultBalanceCurrency: null,
      createdAt: new Date('2026-10-16T12:00:00.000Z'),
      processedAt: null,
    } satisfies WagerTransactionReadModel);

    expect(response.pendingSince).toBe('2026-10-16T12:00:00.000Z');
    expect(response.nextAttemptAt).toBe('2026-10-16T12:01:00.000Z');
    expect(response.resultBalance).toBeNull();
    expect('payloadHash' in response).toBe(false);
    expect('idempotencyKey' in response).toBe(false);
  });
});

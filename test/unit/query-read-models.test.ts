import { describe, expect, test } from 'bun:test';

import type {
  LedgerEntryReadModel,
  LedgerPage,
} from '../../src/modules/wallets/application/ports/ledger-query-repository.port';
import type { WagerTransactionReadModel } from '../../src/modules/wagering/application/ports/wager-transaction-query-repository.port';

describe('query read models', () => {
  test('keep ledger money and timestamps typed for read-only pagination', () => {
    const entry: LedgerEntryReadModel = {
      id: '018f0000-0000-7000-8000-000000000001',
      transactionId: '018f0000-0000-7000-8000-000000000002',
      walletId: '018f0000-0000-7000-8000-000000000003',
      direction: 'CREDIT',
      amount: '100.00',
      currency: 'BRL',
      balanceBefore: '0.00',
      balanceAfter: '100.00',
      createdAt: new Date('2026-10-16T12:00:00.000Z'),
    };
    const page: LedgerPage = { items: [entry], hasNextPage: false };

    expect(page.items[0]?.amount).toBe('100.00');
    expect(page.items[0]?.createdAt).toBeInstanceOf(Date);
    expect(page.hasNextPage).toBe(false);
  });

  test('represents every persisted transaction state without write-only fields', () => {
    const transaction: WagerTransactionReadModel = {
      id: '018f0000-0000-7000-8000-000000000004',
      providerId: 'provider-a',
      externalTransactionId: 'external-a',
      walletId: '018f0000-0000-7000-8000-000000000003',
      playerId: '018f0000-0000-7000-8000-000000000005',
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

    expect(transaction.status).toBe('PROCESSED');
    expect(transaction.amount).toBe('25.00');
    expect('payloadHash' in transaction).toBe(false);
    expect('idempotencyKey' in transaction).toBe(false);
  });
});

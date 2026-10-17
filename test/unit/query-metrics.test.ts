import { describe, expect, test } from 'bun:test';

import { InvalidTransactionIdentifierError } from '../../src/modules/wagering/application/errors/invalid-transaction-identifier.error';
import { GetWagerTransactionUseCase } from '../../src/modules/wagering/application/get-wager-transaction.use-case';
import type { WagerTransactionQueryRepository } from '../../src/modules/wagering/application/ports/wager-transaction-query-repository.port';
import { LedgerCursorCodec } from '../../src/modules/wallets/application/ledger-cursor.codec';
import { ListLedgerUseCase } from '../../src/modules/wallets/application/list-ledger.use-case';
import type { LedgerQueryRepository } from '../../src/modules/wallets/application/ports/ledger-query-repository.port';
import type { WalletRepository } from '../../src/modules/wallets/application/ports/wallet-repository.port';
import type { Wallet } from '../../src/modules/wallets/domain/wallet';
import { InMemoryMetrics } from '../../src/shared/infrastructure/metrics/in-memory-metrics';

const walletId = '018f0000-0000-7000-8000-000000000001';

describe('read query metrics', () => {
  test('records operation and outcome without identifiers as tags', async () => {
    const metrics = new InMemoryMetrics();
    const walletRepository = {
      findById: async () => ({}),
    } as unknown as WalletRepository<Wallet>;
    const ledgerRepository: LedgerQueryRepository = {
      findPage: async () => ({ items: [], hasNextPage: false }),
    };
    const ledgerUseCase = new ListLedgerUseCase(
      walletRepository,
      ledgerRepository,
      new LedgerCursorCodec(),
      metrics,
    );

    await ledgerUseCase.execute({ walletId });

    expect(metrics.snapshot().get('read_queries_total{operation=LEDGER_LIST,outcome=success}')).toBe(1);
    expect(metrics.observationsSnapshot().has('read_query_duration_ms{operation=LEDGER_LIST,outcome=success}')).toBe(true);
    expect([...metrics.snapshot().keys()].join('|')).not.toContain(walletId);
  });

  test('records invalid input and not found outcomes for transaction reads', async () => {
    const metrics = new InMemoryMetrics();
    const query: WagerTransactionQueryRepository = {
      findById: async () => null,
      findByProviderExternalId: async () => null,
    };
    const useCase = new GetWagerTransactionUseCase(query, metrics);

    await expect(useCase.executeById('invalid')).rejects.toBeInstanceOf(InvalidTransactionIdentifierError);
    await expect(useCase.executeByProviderExternalId('provider-a', 'external-a')).rejects.toThrow();

    expect(metrics.snapshot().get('read_queries_total{operation=TRANSACTION_BY_ID,outcome=invalid_input}')).toBe(1);
    expect(metrics.snapshot().get('read_queries_total{operation=TRANSACTION_BY_EXTERNAL,outcome=not_found}')).toBe(1);
  });

  test('does not turn a metrics adapter failure into a read failure', async () => {
    const metrics = {
      increment: () => { throw new Error('metrics unavailable'); },
      observe: () => { throw new Error('metrics unavailable'); },
    };
    const query: WagerTransactionQueryRepository = {
      findById: async () => null,
      findByProviderExternalId: async () => null,
    };
    const useCase = new GetWagerTransactionUseCase(query, metrics);

    await expect(useCase.executeById(walletId)).rejects.toThrow('TRANSACTION_NOT_FOUND');
  });
});

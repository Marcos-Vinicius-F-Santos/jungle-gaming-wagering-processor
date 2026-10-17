import { describe, expect, test } from 'bun:test';

import { InMemoryMetrics } from '../../src/shared/infrastructure/metrics/in-memory-metrics';
import { ReconcileWalletUseCase } from '../../src/modules/reconciliation/application/reconcile-wallet.use-case';
import { ReconciliationCalculator } from '../../src/modules/reconciliation/application/reconciliation-calculator';
import type { ReconciliationQueryRepository } from '../../src/modules/reconciliation/application/ports/reconciliation-query-repository.port';
import type { AppLogger } from '../../src/shared/application/ports/logger.port';

const walletId = '018f0000-0000-7000-8000-000000000001';

const consistentSnapshot = {
  walletId,
  currency: 'BRL',
  storedBalance: '10.00',
  entries: [{
    id: '018f0000-0000-7000-8000-000000000002',
    direction: 'CREDIT' as const,
    amount: '10.00',
    currency: 'BRL',
    balanceBefore: '0.00',
    balanceAfter: '10.00',
    createdAt: new Date('2026-10-16T12:00:00.000Z'),
  }],
};

describe('reconciliation observability', () => {
  test('records controlled metrics and an operational log for divergence', async () => {
    const metrics = new InMemoryMetrics();
    const logs: string[] = [];
    const logger: AppLogger = {
      info: (event) => logs.push(event),
      warn: (event) => logs.push(event),
      error: (event) => logs.push(event),
    };
    const repository: ReconciliationQueryRepository = {
      async findSnapshot() {
        return { ...consistentSnapshot, storedBalance: '5.00' };
      },
    };
    const useCase = new ReconcileWalletUseCase(repository, new ReconciliationCalculator(), metrics, logger);

    const result = await useCase.execute(walletId);

    expect(result.consistent).toBe(false);
    expect(metrics.snapshot().get('wallet_reconciliations_total{outcome=inconsistent}')).toBe(1);
    expect(metrics.snapshot().get('wallet_reconciliation_entries_checked_total{outcome=inconsistent}')).toBe(1);
    expect(metrics.observationsSnapshot().get('wallet_reconciliation_duration_ms{outcome=inconsistent}')?.length).toBe(1);
    expect(logs).toEqual(['wallet.reconciliation.inconsistent']);
  });

  test('records not found and invalid input without querying business state', async () => {
    const metrics = new InMemoryMetrics();
    const repository: ReconciliationQueryRepository = { findSnapshot: async () => null };
    const useCase = new ReconcileWalletUseCase(repository, new ReconciliationCalculator(), metrics);

    await expect(useCase.execute(walletId)).rejects.toThrow();
    await expect(useCase.execute('invalid')).rejects.toThrow();

    expect(metrics.snapshot().get('wallet_reconciliations_total{outcome=not_found}')).toBe(1);
    expect(metrics.snapshot().get('wallet_reconciliations_total{outcome=invalid_input}')).toBe(1);
  });

  test('does not fail the result when metrics throw', async () => {
    const metrics = {
      increment: () => { throw new Error('metrics unavailable'); },
      observe: () => { throw new Error('metrics unavailable'); },
    };
    const repository: ReconciliationQueryRepository = {
      async findSnapshot() {
        return consistentSnapshot;
      },
    };
    const useCase = new ReconcileWalletUseCase(repository, new ReconciliationCalculator(), metrics);

    await expect(useCase.execute(walletId)).resolves.toMatchObject({ consistent: true });
  });
});

import { describe, expect, test } from 'bun:test';

import { WalletNotFoundError } from '../../src/modules/wallets/application/errors/wallet-not-found.error';
import { InvalidReconciliationIdentifierError } from '../../src/modules/reconciliation/application/errors/invalid-reconciliation-identifier.error';
import { ReconciliationUnavailableError } from '../../src/modules/reconciliation/application/errors/reconciliation-unavailable.error';
import { ReconcileWalletUseCase } from '../../src/modules/reconciliation/application/reconcile-wallet.use-case';
import { ReconciliationCalculator } from '../../src/modules/reconciliation/application/reconciliation-calculator';
import type { ReconciliationQueryRepository } from '../../src/modules/reconciliation/application/ports/reconciliation-query-repository.port';

const walletId = '018f0000-0000-7000-8000-000000000001';
const snapshot = {
  walletId,
  currency: 'BRL',
  storedBalance: '0.00',
  entries: [],
} as const;

describe('ReconcileWalletUseCase', () => {
  test('returns a calculated result from one read-only snapshot', async () => {
    let calls = 0;
    const repository: ReconciliationQueryRepository = {
      async findSnapshot(id) {
        calls += 1;
        return id === walletId ? snapshot : null;
      },
    };
    const useCase = new ReconcileWalletUseCase(repository, new ReconciliationCalculator());

    await expect(useCase.execute(walletId)).resolves.toMatchObject({
      walletId,
      consistent: true,
      checkedEntries: 0,
    });
    expect(calls).toBe(1);
  });

  test('rejects invalid identifiers before querying', async () => {
    let called = false;
    const repository: ReconciliationQueryRepository = {
      async findSnapshot() {
        called = true;
        return null;
      },
    };
    const useCase = new ReconcileWalletUseCase(repository, new ReconciliationCalculator());

    await expect(useCase.execute('not-a-uuid')).rejects.toBeInstanceOf(InvalidReconciliationIdentifierError);
    expect(called).toBe(false);
  });

  test('maps missing wallets and repository failures safely', async () => {
    const missing = new ReconcileWalletUseCase({ findSnapshot: async () => null }, new ReconciliationCalculator());
    await expect(missing.execute(walletId)).rejects.toBeInstanceOf(WalletNotFoundError);

    const unavailable = new ReconcileWalletUseCase({
      findSnapshot: async () => {
        throw new Error('database details must not escape');
      },
    }, new ReconciliationCalculator());
    await expect(unavailable.execute(walletId)).rejects.toBeInstanceOf(ReconciliationUnavailableError);
  });
});

import { BadRequestException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { describe, expect, test } from 'bun:test';

import { WalletNotFoundError } from '../../src/modules/wallets/application/errors/wallet-not-found.error';
import { InvalidReconciliationIdentifierError } from '../../src/modules/reconciliation/application/errors/invalid-reconciliation-identifier.error';
import { ReconciliationUnavailableError } from '../../src/modules/reconciliation/application/errors/reconciliation-unavailable.error';
import { ReconciliationController } from '../../src/modules/reconciliation/http/reconciliation.controller';
import type { ReconciliationResult } from '../../src/modules/reconciliation/application/ports/reconciliation-query-repository.port';

const walletId = '018f0000-0000-7000-8000-000000000001';
const result: ReconciliationResult = {
  walletId,
  storedBalance: { amount: '100.00', currency: 'BRL' },
  calculatedBalance: { amount: '75.00', currency: 'BRL' },
  difference: { amount: '-25.00', currency: 'BRL' },
  consistent: false,
  checkedEntries: 2,
  issues: ['BALANCE_DIFFERENCE'],
};

describe('ReconciliationController', () => {
  test('returns 200-compatible data for a divergence', async () => {
    const controller = new ReconciliationController({ execute: async () => result } as never);

    await expect(controller.reconcile(walletId)).resolves.toEqual(result);
  });

  test('maps application failures to safe HTTP exceptions', async () => {
    const invalid = new ReconciliationController({
      execute: async () => { throw new InvalidReconciliationIdentifierError('invalid'); },
    } as never);
    await expect(invalid.reconcile(walletId)).rejects.toBeInstanceOf(BadRequestException);

    const missing = new ReconciliationController({
      execute: async () => { throw new WalletNotFoundError(walletId); },
    } as never);
    await expect(missing.reconcile(walletId)).rejects.toBeInstanceOf(NotFoundException);

    const unavailable = new ReconciliationController({
      execute: async () => { throw new ReconciliationUnavailableError(); },
    } as never);
    await expect(unavailable.reconcile(walletId)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});

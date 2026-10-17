import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { INestApplicationContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { v4 } from 'uuid';

import { AppModule } from '../../src/app.module';
import { CreateWalletUseCase } from '../../src/modules/wallets/application/create-wallet.use-case';
import { RECONCILIATION_QUERY_REPOSITORY } from '../../src/modules/reconciliation/application/ports/reconciliation-query-repository.port';
import type { ReconciliationQueryRepository } from '../../src/modules/reconciliation/application/ports/reconciliation-query-repository.port';
import { Money } from '../../src/shared/domain/money';

describe('PostgreSQL reconciliation snapshot', () => {
  let app: INestApplicationContext;
  let repository: ReconciliationQueryRepository;
  let createWallet: CreateWalletUseCase;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef;
    repository = app.get<ReconciliationQueryRepository>(RECONCILIATION_QUERY_REPOSITORY);
    createWallet = app.get(CreateWalletUseCase);
  });

  afterAll(async () => {
    await app.close();
  });

  test('reads wallet and ledger together without writing state', async () => {
    const wallet = await createWallet.execute({ playerId: v4(), initialBalance: Money.of('100.00', 'BRL') });

    const snapshot = await repository.findSnapshot(wallet.id);

    expect(snapshot?.walletId).toBe(wallet.id);
    expect(snapshot?.storedBalance).toBe('100.00');
    expect(snapshot?.currency).toBe('BRL');
    expect(snapshot?.entries).toHaveLength(1);
    expect(snapshot?.entries[0]?.balanceAfter).toBe('100.00');
    await expect(repository.findSnapshot(v4())).resolves.toBeNull();
  });
});

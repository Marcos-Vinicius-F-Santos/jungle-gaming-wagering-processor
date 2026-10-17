import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { INestApplicationContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { EntityManager } from '@mikro-orm/postgresql';
import { v4 } from 'uuid';

import { AppModule } from '../../src/app.module';
import { CreateWalletUseCase } from '../../src/modules/wallets/application/create-wallet.use-case';
import { ProcessWagerTransactionUseCase } from '../../src/modules/wagering/application/process-wager-transaction.use-case';
import { ReconcileWalletUseCase } from '../../src/modules/reconciliation/application/reconcile-wallet.use-case';
import { WalletEntity } from '../../src/modules/wallets/infrastructure/persistence/entities/wallet.entity';
import { Money } from '../../src/shared/domain/money';

describe('Wallet reconciliation with PostgreSQL', () => {
  let app: INestApplicationContext;
  let createWallet: CreateWalletUseCase;
  let processTransaction: ProcessWagerTransactionUseCase;
  let reconcileWallet: ReconcileWalletUseCase;
  let entityManager: EntityManager;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef;
    createWallet = app.get(CreateWalletUseCase);
    processTransaction = app.get(ProcessWagerTransactionUseCase);
    reconcileWallet = app.get(ReconcileWalletUseCase);
    entityManager = app.get(EntityManager);
  });

  afterAll(async () => {
    await app.close();
  });

  test('reconciles an empty wallet and a wallet with OPENING and BET', async () => {
    const emptyWallet = await createWallet.execute({ playerId: v4(), initialBalance: Money.of('0.00', 'BRL') });
    const empty = await reconcileWallet.execute(emptyWallet.id);
    expect(empty).toMatchObject({
      walletId: emptyWallet.id,
      calculatedBalance: { amount: '0.00', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 0,
      issues: [],
    });

    const playerId = v4();
    const wallet = await createWallet.execute({ playerId, initialBalance: Money.of('100.00', 'BRL') });
    await processTransaction.execute({
      providerId: 'reconciliation-integration',
      externalTransactionId: `bet-${v4()}`,
      idempotencyKey: `key-${v4()}`,
      playerId,
      walletId: wallet.id,
      roundId: 'reconciliation-round',
      gameId: 'reconciliation-game',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
    });

    const consistent = await reconcileWallet.execute(wallet.id);
    expect(consistent).toMatchObject({
      walletId: wallet.id,
      storedBalance: { amount: '75.00', currency: 'BRL' },
      calculatedBalance: { amount: '75.00', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 2,
      issues: [],
    });
  });

  test('signals a controlled materialized-balance divergence without correcting it', async () => {
    const wallet = await createWallet.execute({ playerId: v4(), initialBalance: Money.of('100.00', 'BRL') });

    await entityManager.nativeUpdate(WalletEntity, { id: wallet.id }, { balanceAmount: '50.00' });
    try {
      const result = await reconcileWallet.execute(wallet.id);

      expect(result).toMatchObject({
        storedBalance: { amount: '50.00', currency: 'BRL' },
        calculatedBalance: { amount: '100.00', currency: 'BRL' },
        difference: { amount: '50.00', currency: 'BRL' },
        consistent: false,
        checkedEntries: 1,
        issues: ['BALANCE_DIFFERENCE'],
      });
    } finally {
      await entityManager.nativeUpdate(WalletEntity, { id: wallet.id }, { balanceAmount: '100.00' });
    }
  });

  test('keeps the result consistent while a financial operation commits concurrently', async () => {
    const playerId = v4();
    const wallet = await createWallet.execute({ playerId, initialBalance: Money.of('1000.00', 'BRL') });
    const transaction = {
      providerId: 'reconciliation-concurrency',
      externalTransactionId: `bet-${v4()}`,
      idempotencyKey: `key-${v4()}`,
      playerId,
      walletId: wallet.id,
      roundId: 'reconciliation-concurrent-round',
      gameId: 'reconciliation-concurrent-game',
      kind: 'BET' as const,
      money: { amount: '10.00', currency: 'BRL' },
    };

    const [reconciliation] = await Promise.all([
      reconcileWallet.execute(wallet.id),
      processTransaction.execute(transaction),
    ]);
    const afterCommit = await reconcileWallet.execute(wallet.id);

    expect(reconciliation.consistent).toBe(true);
    expect(reconciliation.difference.amount).toBe('0.00');
    expect(afterCommit.consistent).toBe(true);
    expect(afterCommit.difference.amount).toBe('0.00');
    expect(afterCommit.calculatedBalance.amount).toBe('990.00');
  });
});

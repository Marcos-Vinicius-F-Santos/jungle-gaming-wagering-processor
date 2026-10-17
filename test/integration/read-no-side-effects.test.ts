import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { INestApplicationContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { EntityManager } from '@mikro-orm/postgresql';
import { v4 } from 'uuid';

import { AppModule } from '../../src/app.module';
import { CreateWalletUseCase } from '../../src/modules/wallets/application/create-wallet.use-case';
import { ListLedgerUseCase } from '../../src/modules/wallets/application/list-ledger.use-case';
import {
  WAGER_TRANSACTION_QUERY_REPOSITORY,
} from '../../src/modules/wagering/application/ports/wager-transaction-query-repository.port';
import type {
  WagerTransactionQueryRepository,
} from '../../src/modules/wagering/application/ports/wager-transaction-query-repository.port';
import { ProcessWagerTransactionUseCase } from '../../src/modules/wagering/application/process-wager-transaction.use-case';
import { ReconcileWalletUseCase } from '../../src/modules/reconciliation/application/reconcile-wallet.use-case';
import { Money } from '../../src/shared/domain/money';

interface FinancialSnapshot {
  balanceAmount: string;
  version: number;
  ledgerCount: string;
  transactionCount: string;
  inboxCount: string;
  outboxCount: string;
}

describe('read query side effects', () => {
  let app: INestApplicationContext;
  let entityManager: EntityManager;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef;
    entityManager = app.get(EntityManager);
  });

  afterAll(async () => {
    await app.close();
  });

  test('keeps financial, inbox and outbox snapshots unchanged after reads', async () => {
    const createWallet = app.get(CreateWalletUseCase);
    const processTransaction = app.get(ProcessWagerTransactionUseCase);
    const listLedger = app.get(ListLedgerUseCase);
    const reconcileWallet = app.get(ReconcileWalletUseCase);
    const transactionQuery = app.get<WagerTransactionQueryRepository>(WAGER_TRANSACTION_QUERY_REPOSITORY);
    const playerId = v4();
    const wallet = await createWallet.execute({
      playerId,
      initialBalance: Money.of('100.00', 'BRL'),
    });
    const transactionResult = await processTransaction.execute({
      providerId: 'side-effect-query-provider',
      externalTransactionId: `side-effect-${v4()}`,
      idempotencyKey: `side-effect-key-${v4()}`,
      playerId,
      walletId: wallet.id,
      roundId: 'side-effect-round',
      gameId: 'side-effect-game',
      kind: 'BET',
      money: { amount: '10.00', currency: 'BRL' },
    });
    const before = await snapshot(entityManager, wallet.id);

    await listLedger.execute({ walletId: wallet.id, limit: 1 });
    await transactionQuery.findById(transactionResult.transactionId);
    await transactionQuery.findByProviderExternalId('side-effect-query-provider', `missing-${v4()}`);
    await listLedger.execute({ walletId: wallet.id, limit: 100 });
    await reconcileWallet.execute(wallet.id);
    await expect(reconcileWallet.execute(v4())).rejects.toThrow();

    const after = await snapshot(entityManager, wallet.id);
    expect(after).toEqual(before);
  });
});

async function snapshot(entityManager: EntityManager, walletId: string): Promise<FinancialSnapshot> {
  const connection = entityManager.getConnection();
  const wallet = await connection.execute<{ balance_amount: string; version: number }[]>(
    'select balance_amount, version from wallets where id = ?',
    [walletId],
  );
  const ledger = await connection.execute<{ count: string }[]>(
    'select count(*)::text as count from wallet_ledger_entries where wallet_id = ?',
    [walletId],
  );
  const transactions = await connection.execute<{ count: string }[]>(
    'select count(*)::text as count from wager_transactions where wallet_id = ?',
    [walletId],
  );
  const inbox = await connection.execute<{ count: string }[]>(
    'select count(*)::text as count from inbox_messages',
  );
  const outbox = await connection.execute<{ count: string }[]>(
    'select count(*)::text as count from outbox_messages where aggregate_id in (select id from wager_transactions where wallet_id = ?)',
    [walletId],
  );

  return {
    balanceAmount: wallet[0]!.balance_amount,
    version: wallet[0]!.version,
    ledgerCount: ledger[0]!.count,
    transactionCount: transactions[0]!.count,
    inboxCount: inbox[0]!.count,
    outboxCount: outbox[0]!.count,
  };
}

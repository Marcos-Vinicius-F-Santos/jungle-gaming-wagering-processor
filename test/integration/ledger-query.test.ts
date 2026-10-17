import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { INestApplicationContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { v4 } from 'uuid';

import { AppModule } from '../../src/app.module';
import { CreateWalletUseCase } from '../../src/modules/wallets/application/create-wallet.use-case';
import { ListLedgerUseCase } from '../../src/modules/wallets/application/list-ledger.use-case';
import { WalletNotFoundError } from '../../src/modules/wallets/application/errors/wallet-not-found.error';
import {
  LEDGER_QUERY_REPOSITORY,
} from '../../src/modules/wallets/application/ports/ledger-query-repository.port';
import type {
  LedgerQueryRepository,
} from '../../src/modules/wallets/application/ports/ledger-query-repository.port';
import { ProcessWagerTransactionUseCase } from '../../src/modules/wagering/application/process-wager-transaction.use-case';
import { Money } from '../../src/shared/domain/money';

describe('PostgreSQL paginated ledger query', () => {
  let app: INestApplicationContext;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef;
  });

  afterAll(async () => {
    await app.close();
  });

  test('returns descending pages without repeating entries and keeps wallet scope', async () => {
    const createWallet = app.get(CreateWalletUseCase);
    const processTransaction = app.get(ProcessWagerTransactionUseCase);
    const ledger = app.get<LedgerQueryRepository>(LEDGER_QUERY_REPOSITORY);
    const listLedger = app.get(ListLedgerUseCase);
    const playerId = v4();
    const wallet = await createWallet.execute({
      playerId,
      initialBalance: Money.of('100.00', 'BRL'),
    });

    await processTransaction.execute({
      providerId: 'ledger-query-test',
      externalTransactionId: `bet-${v4()}`,
      idempotencyKey: `key-${v4()}`,
      playerId,
      walletId: wallet.id,
      roundId: 'round-ledger-query',
      gameId: 'game-ledger-query',
      kind: 'BET',
      money: { amount: '10.00', currency: 'BRL' },
    });

    const firstPage = await ledger.findPage(wallet.id, undefined, 1);
    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.hasNextPage).toBe(true);
    expect(firstPage.items[0]?.walletId).toBe(wallet.id);
    expect(firstPage.items[0]?.amount).toBe('10.00');

    const firstItem = firstPage.items[0];
    if (!firstItem) throw new Error('expected a first ledger item');
    const secondPage = await ledger.findPage(wallet.id, {
      walletId: wallet.id,
      createdAt: firstItem.createdAt,
      id: firstItem.id,
    }, 1);

    expect(secondPage.items).toHaveLength(1);
    expect(secondPage.hasNextPage).toBe(false);
    expect(secondPage.items[0]?.id).not.toBe(firstItem.id);
    expect(secondPage.items[0]?.amount).toBe('100.00');

    const otherWallet = await createWallet.execute({
      playerId: v4(),
      initialBalance: Money.of('50.00', 'BRL'),
    });
    const otherPage = await ledger.findPage(otherWallet.id, undefined, 10);
    expect(otherPage.items.every((item) => item.walletId === otherWallet.id)).toBe(true);

    const emptyWallet = await createWallet.execute({
      playerId: v4(),
      initialBalance: Money.of('0.00', 'BRL'),
    });
    const emptyPage = await listLedger.execute({ walletId: emptyWallet.id });
    expect(emptyPage.items).toHaveLength(0);
    expect(emptyPage.nextCursor).toBeNull();
    await expect(listLedger.execute({ walletId: v4() })).rejects.toBeInstanceOf(WalletNotFoundError);
  });
});

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { INestApplicationContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { v4 } from 'uuid';

import { AppModule } from '../../src/app.module';
import { CreateWalletUseCase } from '../../src/modules/wallets/application/create-wallet.use-case';
import { WalletAlreadyExistsError } from '../../src/modules/wallets/application/errors/wallet-already-exists.error';
import { GetWalletUseCase } from '../../src/modules/wallets/application/get-wallet.use-case';
import { WalletNotFoundError } from '../../src/modules/wallets/application/errors/wallet-not-found.error';
import { Money } from '../../src/shared/domain/money';
import { EntityManager } from '@mikro-orm/postgresql';

describe('CreateWalletUseCase with PostgreSQL', () => {
  let app: INestApplicationContext;
  let useCase: CreateWalletUseCase;
  let getWallet: GetWalletUseCase;
  let entityManager: EntityManager;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef;
    useCase = app.get(CreateWalletUseCase);
    getWallet = app.get(GetWalletUseCase);
    entityManager = app.get(EntityManager);
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  test('persists a positive wallet, OPENING and one ledger entry atomically', async () => {
    const playerId = v4();
    const result = await useCase.execute({ playerId, initialBalance: Money.of('1000.00', 'BRL') });
    const rows = await entityManager.getConnection().execute<{ wallets: string; transactions: string; ledger: string }[]>(
      `select
         (select count(*) from wallets where id = ?) as wallets,
         (select count(*) from wager_transactions where wallet_id = ?) as transactions,
         (select count(*) from wallet_ledger_entries where wallet_id = ?) as ledger`,
      [result.id, result.id, result.id],
    );

    expect(result.balance).toEqual({ amount: '1000.00', currency: 'BRL' });
    expect(result.version).toBe(1);
    expect(rows[0]).toEqual({ wallets: '1', transactions: '1', ledger: '1' });
  });

  test('persists a zero-balance wallet without OPENING or ledger rows', async () => {
    const result = await useCase.execute({ playerId: v4(), initialBalance: Money.of('0.00', 'USD') });
    const rows = await entityManager.getConnection().execute<{ transactions: string; ledger: string }[]>(
      `select
         (select count(*) from wager_transactions where wallet_id = ?) as transactions,
         (select count(*) from wallet_ledger_entries where wallet_id = ?) as ledger`,
      [result.id, result.id],
    );

    expect(rows[0]).toEqual({ transactions: '0', ledger: '0' });
  });

  test('rejects a duplicate wallet before creating financial rows', async () => {
    const playerId = v4();
    await useCase.execute({ playerId, initialBalance: Money.of('1.00', 'EUR') });

    await expect(useCase.execute({ playerId, initialBalance: Money.of('2.00', 'EUR') })).rejects.toBeInstanceOf(WalletAlreadyExistsError);
  });

  test('returns the persisted wallet and does not expose ORM state', async () => {
    const created = await useCase.execute({ playerId: v4(), initialBalance: Money.of('12.30', 'BRL') });

    const queried = await getWallet.execute(created.id);
    expect(queried).toEqual(created);
    await expect(getWallet.execute(v4())).rejects.toBeInstanceOf(WalletNotFoundError);
  });
});

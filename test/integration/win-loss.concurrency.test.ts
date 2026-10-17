import 'reflect-metadata';

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { EntityManager } from '@mikro-orm/postgresql';
import { v4 } from 'uuid';

import { AppModule } from '../../src/app.module';

describe('WIN/LOSS concurrency and replay', () => {
  let app: INestApplication;
  let baseUrl: string;
  let entityManager: EntityManager;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    await app.listen(0);
    baseUrl = await app.getUrl();
    entityManager = app.get(EntityManager);
  });

  afterAll(async () => {
    await app.close();
  });

  async function createWallet(amount: string): Promise<{ id: string; playerId: string }> {
    const playerId = v4();
    const response = await fetch(`${baseUrl}/wallets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ playerId, initialBalance: { amount, currency: 'BRL' } }),
    });
    expect(response.status).toBe(201);
    return { id: (await response.json()).id, playerId };
  }

  function body(
    wallet: { id: string; playerId: string },
    externalTransactionId: string,
    key: string,
    kind: 'WIN' | 'LOSS' = 'WIN',
  ) {
    return {
      providerId: 'provider-win-loss-concurrency',
      externalTransactionId,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-concurrency',
      gameId: 'game-concurrency',
      kind,
      money: { amount: '80.00', currency: 'BRL' },
      key,
    };
  }

  async function submit(value: ReturnType<typeof body>) {
    const { key, ...payload } = value;
    return fetch(`${baseUrl}/wagering/transactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Idempotency-Key': key },
      body: JSON.stringify(payload),
    });
  }

  test('processes two concurrent WINs without a lost update', async () => {
    const wallet = await createWallet('100.00');
    const first = body(wallet, `win-a-${v4()}`, `key-a-${v4()}`);
    const second = body(wallet, `win-b-${v4()}`, `key-b-${v4()}`);
    const responses = await Promise.all([submit(first), submit(second)]);

    expect(responses.map((response) => response.status).sort()).toEqual([201, 201]);
    const rows = await entityManager.getConnection().execute<{ balance_amount: string; version: number; credits: string }[]>(
      `select
        (select balance_amount from wallets where id = ?) as balance_amount,
        (select version from wallets where id = ?) as version,
        (select count(*)
         from wallet_ledger_entries ledger
         join wager_transactions wager on wager.id = ledger.transaction_id
         where ledger.wallet_id = ? and ledger.direction = 'CREDIT' and wager.kind = 'WIN') as credits`,
      [wallet.id, wallet.id, wallet.id],
    );

    expect(rows[0]).toEqual({ balance_amount: '260.00', version: 3, credits: '2' });
  });

  test('processes one effect for fifty parallel replays of the same WIN', async () => {
    const wallet = await createWallet('100.00');
    const command = body(wallet, `win-replay-${v4()}`, `key-replay-${v4()}`);
    const responses = await Promise.all(Array.from({ length: 50 }, () => submit(command)));
    const bodies = await Promise.all(responses.map((response) => response.json()));

    expect(responses.filter((response) => response.status === 201)).toHaveLength(1);
    expect(responses.filter((response) => response.status === 200)).toHaveLength(49);
    expect(new Set(bodies.map((value) => value.transactionId)).size).toBe(1);

    const rows = await entityManager.getConnection().execute<{ credits: string }[]>(
      `select count(*) as credits
       from wallet_ledger_entries ledger
       join wager_transactions wager on wager.id = ledger.transaction_id
       where ledger.wallet_id = ? and ledger.direction = 'CREDIT' and wager.kind = 'WIN'`,
      [wallet.id],
    );
    expect(rows[0].credits).toBe('1');
  });

  test('processes one audit record for fifty parallel replays of the same LOSS', async () => {
    const wallet = await createWallet('100.00');
    const command = body(wallet, `loss-replay-${v4()}`, `key-loss-replay-${v4()}`, 'LOSS');
    const responses = await Promise.all(Array.from({ length: 50 }, () => submit(command)));
    const bodies = await Promise.all(responses.map((response) => response.json()));

    expect(responses.filter((response) => response.status === 201)).toHaveLength(1);
    expect(responses.filter((response) => response.status === 200)).toHaveLength(49);
    expect(new Set(bodies.map((value) => value.transactionId)).size).toBe(1);

    const rows = await entityManager.getConnection().execute<{
      transactions: string;
      lossLedger: string;
      balance_amount: string;
      version: number;
    }[]>(
      `select
        (select count(*) from wager_transactions where wallet_id = ? and idempotency_key = ?) as transactions,
        (select count(*)
         from wallet_ledger_entries ledger
         join wager_transactions wager on wager.id = ledger.transaction_id
         where ledger.wallet_id = ? and wager.kind = 'LOSS') as "lossLedger",
        (select balance_amount from wallets where id = ?) as balance_amount,
        (select version from wallets where id = ?) as version`,
      [wallet.id, command.key, wallet.id, wallet.id, wallet.id],
    );

    expect(rows[0]).toEqual({ transactions: '1', lossLedger: '0', balance_amount: '100.00', version: 1 });
  });
});

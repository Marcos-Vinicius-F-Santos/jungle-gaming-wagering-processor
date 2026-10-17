import 'reflect-metadata';

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { v4 } from 'uuid';
import { EntityManager } from '@mikro-orm/postgresql';

import { AppModule } from '../../src/app.module';

describe('wagering concurrency and regression', () => {
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
    const body = await response.json();
    return { id: body.id, playerId };
  }

  function wagerBody(wallet: { id: string; playerId: string }, amount: string, externalTransactionId: string) {
    return {
      providerId: 'provider-concurrency',
      externalTransactionId,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-concurrency',
      gameId: 'game-concurrency',
      kind: 'BET',
      money: { amount, currency: 'BRL' },
    };
  }

  async function submit(body: unknown, idempotencyKey: string): Promise<Response> {
    return fetch(`${baseUrl}/wagering/transactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify(body),
    });
  }

  test('processes one of two concurrent 80.00 BETs and rejects the other', async () => {
    const wallet = await createWallet('100.00');
    const responses = await Promise.all([
      submit(wagerBody(wallet, '80.00', `external-a-${v4()}`), `key-a-${v4()}`),
      submit(wagerBody(wallet, '80.00', `external-b-${v4()}`), `key-b-${v4()}`),
    ]);
    const bodies = await Promise.all(responses.map((response) => response.json()));
    const rows = await entityManager.getConnection().execute<{
      balance_amount: string;
      version: number;
      debits: string;
    }[]>(
      `select
         (select balance_amount from wallets where id = ?) as balance_amount,
         (select version from wallets where id = ?) as version,
         (select count(*) from wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT') as debits`,
      [wallet.id, wallet.id, wallet.id],
    );

    expect(responses.map((response) => response.status).sort()).toEqual([201, 422]);
    expect(bodies.filter((body) => body.status === 'PROCESSED')).toHaveLength(1);
    expect(bodies.filter((body) => body.failureCode === 'INSUFFICIENT_FUNDS')).toHaveLength(1);
    expect(rows[0]).toEqual({ balance_amount: '20.00', version: 2, debits: '1' });
  });

  test('turns 50 parallel replays into one financial effect', async () => {
    const wallet = await createWallet('100.00');
    const key = `replay-${v4()}`;
    const body = wagerBody(wallet, '25.00', `external-replay-${v4()}`);
    const responses = await Promise.all(Array.from({ length: 50 }, () => submit(body, key)));
    const responseBodies = await Promise.all(responses.map((response) => response.json()));
    const rows = await entityManager.getConnection().execute<{ transactions: string; debits: string; version: number }[]>(
      `select
         (select count(*) from wager_transactions where wallet_id = ? and idempotency_key = ?) as transactions,
         (select count(*) from wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT') as debits,
         (select version from wallets where id = ?) as version`,
      [wallet.id, key, wallet.id, wallet.id],
    );

    expect(responses.filter((response) => response.status === 201)).toHaveLength(1);
    expect(responses.filter((response) => response.status === 200)).toHaveLength(49);
    expect(new Set(responseBodies.map((body) => body.transactionId)).size).toBe(1);
    expect(rows[0]).toEqual({ transactions: '1', debits: '1', version: 2 });
  });

  test('keeps distinct wallets processing in parallel and preserves wallet regression', async () => {
    const first = await createWallet('100.00');
    const second = await createWallet('100.00');
    const responses = await Promise.all([
      submit(wagerBody(first, '30.00', `external-first-${v4()}`), `first-${v4()}`),
      submit(wagerBody(second, '40.00', `external-second-${v4()}`), `second-${v4()}`),
    ]);
    const rows = await entityManager.getConnection().execute<{ wallet_id: string; balance_amount: string; version: number }[]>(
      `select id as wallet_id, balance_amount, version
       from wallets
       where id in (?, ?)
       order by id`,
      [first.id, second.id],
    );

    expect(responses.map((response) => response.status).sort()).toEqual([201, 201]);
    expect(rows).toEqual([
      { wallet_id: first.id, balance_amount: '70.00', version: 2 },
      { wallet_id: second.id, balance_amount: '60.00', version: 2 },
    ].sort((left, right) => left.wallet_id.localeCompare(right.wallet_id)));
  });
});

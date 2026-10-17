import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { v4 } from 'uuid';
import { EntityManager } from '@mikro-orm/postgresql';

import { AppModule } from '../../src/app.module';

describe('POST /wallets', () => {
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

  test('returns 201 with a created wallet', async () => {
    const response = await fetch(`${baseUrl}/wallets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        playerId: v4(),
        initialBalance: { amount: '25.00', currency: 'brl' },
      }),
    });
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.balance).toEqual({ amount: '25.00', currency: 'BRL' });
    expect(body.version).toBe(1);
  });

  test('returns 400 before persistence for invalid input', async () => {
    const response = await fetch(`${baseUrl}/wallets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        playerId: 'not-a-uuid',
        initialBalance: { amount: '1e2', currency: 'XYZ' },
      }),
    });

    expect(response.status).toBe(400);
  });

  test('returns 409 for the same player and currency', async () => {
    const playerId = v4();
    const payload = { playerId, initialBalance: { amount: '1.00', currency: 'USD' } };
    await fetch(`${baseUrl}/wallets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const response = await fetch(`${baseUrl}/wallets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });

    expect(response.status).toBe(409);
  });

  test('returns 200 for an existing wallet and 404 for an unknown wallet', async () => {
    const creation = await fetch(`${baseUrl}/wallets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ playerId: v4(), initialBalance: { amount: '7.50', currency: 'EUR' } }),
    });
    const created = await creation.json();

    const found = await fetch(`${baseUrl}/wallets/${created.id}`);
    const missing = await fetch(`${baseUrl}/wallets/${v4()}`);
    const invalid = await fetch(`${baseUrl}/wallets/not-a-uuid`);

    expect(found.status).toBe(200);
    expect((await found.json()).balance).toEqual({ amount: '7.50', currency: 'EUR' });
    expect(missing.status).toBe(404);
    expect(invalid.status).toBe(400);
  });

  test('allows only one concurrent creation for the same player and currency', async () => {
    const playerId = v4();
    const payload = { playerId, initialBalance: { amount: '11.00', currency: 'BRL' } };
    const responses = await Promise.all(Array.from({ length: 10 }, () => fetch(`${baseUrl}/wallets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })));
    const statuses = responses.map((response) => response.status);
    const rows = await entityManager.getConnection().execute<{ wallets: string; transactions: string; ledger: string }[]>(
      `select
         (select count(*) from wallets where player_id = ? and currency = 'BRL') as wallets,
         (select count(*) from wager_transactions where player_id = ?) as transactions,
         (select count(*) from wallet_ledger_entries where wallet_id in (select id from wallets where player_id = ?)) as ledger`,
      [playerId, playerId, playerId],
    );

    expect(statuses.filter((status) => status === 201)).toHaveLength(1);
    expect(statuses.filter((status) => status === 409)).toHaveLength(9);
    expect(rows[0]).toEqual({ wallets: '1', transactions: '1', ledger: '1' });
  });
});

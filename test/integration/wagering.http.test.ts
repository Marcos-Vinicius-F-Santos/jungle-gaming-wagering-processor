import 'reflect-metadata';

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { v4 } from 'uuid';
import { EntityManager } from '@mikro-orm/postgresql';

import { AppModule } from '../../src/app.module';
import { OptimisticLockRetryExhaustedError } from '../../src/modules/wagering/application/errors/optimistic-lock-retry-exhausted.error';
import { ProcessWagerTransactionUseCase } from '../../src/modules/wagering/application/process-wager-transaction.use-case';
import { PendingReferenceWorker } from '../../src/modules/wagering/application/pending-reference.worker';

describe('POST /wagering/transactions', () => {
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

  function payload(wallet: { id: string; playerId: string }, overrides: Record<string, unknown> = {}) {
    return {
      providerId: 'provider-http',
      externalTransactionId: `external-${v4()}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-http',
      gameId: 'game-http',
      kind: 'BET',
      money: { amount: '25.00', currency: 'brl' },
      ...overrides,
    };
  }

  async function submit(body: unknown, key?: string, url = baseUrl): Promise<Response> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (key !== undefined) {
      headers['Idempotency-Key'] = key;
    }
    return fetch(`${url}/wagering/transactions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
  }

  test('returns 201 initially and 200 on replay with the original snapshot', async () => {
    const wallet = await createWallet('100.00');
    const firstPayload = payload(wallet, { externalTransactionId: `first-${v4()}` });
    const firstKey = `first-key-${v4()}`;
    const first = await submit(firstPayload, firstKey);
    const firstBody = await first.json();

    const second = await submit(payload(wallet, { money: { amount: '10.00', currency: 'BRL' } }), `second-key-${v4()}`);
    expect(second.status).toBe(201);

    const replay = await submit(firstPayload, firstKey);
    const replayBody = await replay.json();

    expect(first.status).toBe(201);
    expect(firstBody.status).toBe('PROCESSED');
    expect(firstBody.balance).toEqual({ amount: '75.00', currency: 'BRL' });
    expect(replay.status).toBe(200);
    expect(replayBody).toEqual({
      transactionId: firstBody.transactionId,
      status: 'PROCESSED',
      balance: { amount: '75.00', currency: 'BRL' },
      idempotentReplay: true,
    });
  });

  test('returns 400 for invalid payload or missing idempotency key', async () => {
    const wallet = await createWallet('10.00');
    const invalid = await submit(payload(wallet, { money: { amount: 10, currency: 'BRL' } }), `invalid-${v4()}`);
    const missingKey = await submit(payload(wallet));

    expect(invalid.status).toBe(400);
    expect(missingKey.status).toBe(400);
  });

  test('returns 404 for an unknown wallet without persisting a wager', async () => {
    const providerId = 'provider-not-found';
    const idempotencyKey = `missing-${v4()}`;
    const body = {
      providerId,
      externalTransactionId: `external-${v4()}`,
      playerId: v4(),
      walletId: v4(),
      roundId: 'round-http',
      gameId: 'game-http',
      kind: 'BET',
      money: { amount: '1.00', currency: 'BRL' },
    };
    const response = await submit(body, idempotencyKey);
    const rows = await entityManager.getConnection().execute<{ count: string }[]>(
      'select count(*) as count from wager_transactions where provider_id = ? and idempotency_key = ?',
      [providerId, idempotencyKey],
    );

    expect(response.status).toBe(404);
    expect(rows[0].count).toBe('0');
  });

  test('returns 409 for idempotency and external transaction conflicts', async () => {
    const wallet = await createWallet('100.00');
    const externalTransactionId = `external-conflict-${v4()}`;
    const firstPayload = payload(wallet, { externalTransactionId, money: { amount: '10.00', currency: 'BRL' } });
    const firstKey = `conflict-key-${v4()}`;
    expect((await submit(firstPayload, firstKey)).status).toBe(201);

    const keyConflict = await submit({ ...firstPayload, money: { amount: '11.00', currency: 'BRL' } }, firstKey);
    const externalConflict = await submit(
      { ...firstPayload, money: { amount: '12.00', currency: 'BRL' } },
      `other-key-${v4()}`,
    );

    expect(keyConflict.status).toBe(409);
    expect(externalConflict.status).toBe(409);
  });

  test('returns 422 for a business rejection and does not create a debit', async () => {
    const wallet = await createWallet('5.00');
    const key = `insufficient-${v4()}`;
    const response = await submit(payload(wallet, {
      externalTransactionId: `insufficient-${v4()}`,
      money: { amount: '10.00', currency: 'BRL' },
    }), key);
    const body = await response.json();
    const rows = await entityManager.getConnection().execute<{ ledger: string }[]>(
      `select count(*) as ledger
       from wallet_ledger_entries
       where wallet_id = ? and direction = 'DEBIT'`,
      [wallet.id],
    );

    expect(response.status).toBe(422);
    expect(body.status).toBe('REJECTED');
    expect(body.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect(rows[0].ledger).toBe('0');
  });

  test('returns 503 when the application reports exhausted optimistic-lock retries', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ProcessWagerTransactionUseCase)
      .useValue({ execute: async () => { throw new OptimisticLockRetryExhaustedError(v4(), 3); } })
      .overrideProvider(PendingReferenceWorker)
      .useValue({})
      .compile();
    const transientApp = moduleRef.createNestApplication();
    transientApp.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    await transientApp.listen(0);
    const transientUrl = await transientApp.getUrl();

    const response = await submit({
      providerId: 'provider-transient',
      externalTransactionId: `external-${v4()}`,
      playerId: v4(),
      walletId: v4(),
      roundId: 'round-http',
      gameId: 'game-http',
      kind: 'BET',
      money: { amount: '1.00', currency: 'BRL' },
    }, `transient-${v4()}`, transientUrl);

    await transientApp.close();
    expect(response.status).toBe(503);
  });
});

import 'reflect-metadata';

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { v4 } from 'uuid';

import { AppModule } from '../../src/app.module';

describe('POST /wagering/transactions — REFUND and ROLLBACK', () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    await app.listen(0);
    baseUrl = await app.getUrl();
  });

  afterAll(async () => {
    await app?.close();
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

  async function submit(
    wallet: { id: string; playerId: string },
    providerId: string,
    kind: 'BET' | 'WIN' | 'REFUND' | 'ROLLBACK',
    externalTransactionId: string,
    key: string,
    amount: string,
    referenceExternalTransactionId?: string,
  ) {
    return fetch(`${baseUrl}/wagering/transactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Idempotency-Key': key },
      body: JSON.stringify({
        providerId,
        externalTransactionId,
        referenceExternalTransactionId,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'round-refund-rollback',
        gameId: 'game-refund-rollback',
        kind,
        money: { amount, currency: 'BRL' },
      }),
    });
  }

  test('processes REFUND of a BET and replays it without a second ledger effect', async () => {
    const wallet = await createWallet('100.00');
    const providerId = `provider-refund-${v4()}`;
    const betId = `bet-${v4()}`;
    const bet = await submit(wallet, providerId, 'BET', betId, `key-${betId}`, '25.00');
    expect(bet.status).toBe(201);

    const refundId = `refund-${v4()}`;
    const first = await submit(wallet, providerId, 'REFUND', refundId, `key-${refundId}`, '25.00', betId);
    expect(first.status).toBe(201);
    expect(await first.json()).toMatchObject({ status: 'PROCESSED', balance: { amount: '100.00', currency: 'BRL' } });

    const replay = await submit(wallet, providerId, 'REFUND', refundId, `key-${refundId}`, '25.00', betId);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ idempotentReplay: true, balance: { amount: '100.00', currency: 'BRL' } });
  });

  test('processes ROLLBACK of a WIN as a debit', async () => {
    const wallet = await createWallet('100.00');
    const providerId = `provider-rollback-${v4()}`;
    const winId = `win-${v4()}`;
    const win = await submit(wallet, providerId, 'WIN', winId, `key-${winId}`, '80.00');
    expect(win.status).toBe(201);

    const rollbackId = `rollback-${v4()}`;
    const rollback = await submit(wallet, providerId, 'ROLLBACK', rollbackId, `key-${rollbackId}`, '80.00', winId);
    expect(rollback.status).toBe(201);
    expect(await rollback.json()).toMatchObject({ status: 'PROCESSED', balance: { amount: '100.00', currency: 'BRL' } });
  });

  test('returns 422 for a REFUND with an incompatible reference kind', async () => {
    const wallet = await createWallet('100.00');
    const providerId = `provider-invalid-refund-${v4()}`;
    const winId = `win-${v4()}`;
    const win = await submit(wallet, providerId, 'WIN', winId, `key-${winId}`, '25.00');
    expect(win.status).toBe(201);

    const refund = await submit(wallet, providerId, 'REFUND', `refund-${v4()}`, `key-${v4()}`, '25.00', winId);
    expect(refund.status).toBe(422);
    expect(await refund.json()).toMatchObject({ status: 'REJECTED', failureCode: 'REFERENCE_NOT_COMPATIBLE' });
  });
});

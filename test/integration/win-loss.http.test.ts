import 'reflect-metadata';

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { v4 } from 'uuid';

import { AppModule } from '../../src/app.module';

describe('POST /wagering/transactions — WIN and LOSS', () => {
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

  async function submit(wallet: { id: string; playerId: string }, kind: 'WIN' | 'LOSS', key: string, overrides = {}) {
    return fetch(`${baseUrl}/wagering/transactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Idempotency-Key': key },
      body: JSON.stringify({
        providerId: 'provider-win-loss',
        externalTransactionId: `${kind.toLowerCase()}-${v4()}`,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'round-win-loss',
        gameId: 'game-win-loss',
        kind,
        money: { amount: '80.00', currency: 'brl' },
        ...overrides,
      }),
    });
  }

  test('returns 201 and credits WIN', async () => {
    const wallet = await createWallet('100.00');
    const response = await submit(wallet, 'WIN', `win-${v4()}`);
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.status).toBe('PROCESSED');
    expect(body.balance).toEqual({ amount: '180.00', currency: 'BRL' });
  });

  test('returns 201 and leaves the balance unchanged for LOSS', async () => {
    const wallet = await createWallet('100.00');
    const response = await submit(wallet, 'LOSS', `loss-${v4()}`);
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.status).toBe('PROCESSED');
    expect(body.balance).toEqual({ amount: '100.00', currency: 'BRL' });
  });

  test('returns 202 and persists WIN with a missing reference as pending', async () => {
    const wallet = await createWallet('100.00');
    const response = await submit(wallet, `WIN`, `pending-${v4()}`, {
      referenceExternalTransactionId: `missing-bet-${v4()}`,
    });
    const body = await response.json();

    expect(response.status).toBe(202);
    expect(body.status).toBe('PENDING_REFERENCE');
    expect(body.idempotentReplay).toBe(false);
  });
});

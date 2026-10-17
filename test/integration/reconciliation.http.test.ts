import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { v4 } from 'uuid';

import { AppModule } from '../../src/app.module';

describe('POST /wallets/:walletId/reconciliation', () => {
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

  test('returns a stable consistent response for an empty wallet', async () => {
    const creation = await fetch(`${baseUrl}/wallets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ playerId: v4(), initialBalance: { amount: '0.00', currency: 'BRL' } }),
    });
    const wallet = await creation.json() as { id: string };
    const correlationId = `reconciliation-${v4()}`;

    const response = await fetch(`${baseUrl}/wallets/${wallet.id}/reconciliation`, {
      method: 'POST',
      headers: { 'x-correlation-id': correlationId },
    });
    const body = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(response.headers.get('x-correlation-id')).toBe(correlationId);
    expect(body).toEqual({
      walletId: wallet.id,
      storedBalance: { amount: '0.00', currency: 'BRL' },
      calculatedBalance: { amount: '0.00', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 0,
      issues: [],
    });
  });

  test('maps invalid and missing wallets to safe errors', async () => {
    const invalid = await fetch(`${baseUrl}/wallets/not-a-uuid/reconciliation`, { method: 'POST' });
    const missing = await fetch(`${baseUrl}/wallets/${v4()}/reconciliation`, { method: 'POST' });

    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ code: 'INVALID_IDENTIFIER' });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ code: 'WALLET_NOT_FOUND' });
  });
});

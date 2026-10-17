import 'reflect-metadata';

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { v4 } from 'uuid';

import { AppModule } from '../../src/app.module';

describe('HTTP read queries', () => {
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

  test('serves ledger and transaction lookups through HTTP', async () => {
    const playerId = v4();
    const createResponse = await fetch(`${baseUrl}/wallets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ playerId, initialBalance: { amount: '100.00', currency: 'BRL' } }),
    });
    expect(createResponse.status).toBe(201);
    const wallet = await createResponse.json() as { id: string };
    const providerId = `http-query-${v4()}`;
    const externalTransactionId = `http-bet-${v4()}`;

    const processResponse = await fetch(`${baseUrl}/wagering/transactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Idempotency-Key': `http-key-${v4()}` },
      body: JSON.stringify({
        providerId,
        externalTransactionId,
        playerId,
        walletId: wallet.id,
        roundId: 'http-round',
        gameId: 'http-game',
        kind: 'BET',
        money: { amount: '10.00', currency: 'BRL' },
      }),
    });
    expect(processResponse.status).toBe(201);
    const processed = await processResponse.json() as { transactionId: string };

    const ledgerResponse = await fetch(`${baseUrl}/wallets/${wallet.id}/ledger?limit=1`);
    const ledger = await ledgerResponse.json() as {
      walletId: string;
      items: Array<{ amount: string }>;
      nextCursor: string | null;
    };
    expect(ledgerResponse.status).toBe(200);
    expect(ledger.walletId).toBe(wallet.id);
    expect(ledger.items).toHaveLength(1);
    expect(ledger.nextCursor).not.toBeNull();

    const invalidLimit = await fetch(`${baseUrl}/wallets/${wallet.id}/ledger?limit=101`);
    expect(invalidLimit.status).toBe(400);

    const byIdResponse = await fetch(`${baseUrl}/wagering/transactions/${processed.transactionId}`);
    const byId = await byIdResponse.json() as { id: string; amount: string; resultBalance: { amount: string } };
    expect(byIdResponse.status).toBe(200);
    expect(byId.id).toBe(processed.transactionId);
    expect(byId.amount).toBe('10.00');
    expect(byId.resultBalance.amount).toBe('90.00');

    const byExternalResponse = await fetch(
      `${baseUrl}/providers/${providerId}/wagering/transactions/${externalTransactionId}`,
    );
    expect(byExternalResponse.status).toBe(200);
    expect((await byExternalResponse.json()).id).toBe(processed.transactionId);

    const wrongProviderResponse = await fetch(
      `${baseUrl}/providers/other-provider/wagering/transactions/${externalTransactionId}`,
    );
    expect(wrongProviderResponse.status).toBe(404);
  });
});

import 'reflect-metadata';

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { EntityManager } from '@mikro-orm/postgresql';
import { v4 } from 'uuid';

import { AppModule } from '../../src/app.module';
import { PendingReferenceWorker } from '../../src/modules/wagering/application/pending-reference.worker';

describe('WIN pending reference reprocessing', () => {
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

  async function submit(wallet: { id: string; playerId: string }, body: Record<string, unknown>, key: string) {
    return fetch(`${baseUrl}/wagering/transactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Idempotency-Key': key },
      body: JSON.stringify({
        providerId: 'provider-pending-reference',
        externalTransactionId: `external-${v4()}`,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'round-pending',
        gameId: 'game-pending',
        money: { amount: '80.00', currency: 'BRL' },
        ...body,
      }),
    });
  }

  test('processes a pending WIN once its BET reference appears', async () => {
    const wallet = await createWallet('100.00');
    const referenceExternalTransactionId = `bet-reference-${v4()}`;
    const pendingResponse = await submit(wallet, {
      kind: 'WIN',
      referenceExternalTransactionId,
    }, `pending-${v4()}`);
    const pendingBody = await pendingResponse.json();
    expect(pendingResponse.status).toBe(202);

    const betResponse = await submit(wallet, {
      kind: 'BET',
      externalTransactionId: referenceExternalTransactionId,
      money: { amount: '10.00', currency: 'BRL' },
    }, `bet-${v4()}`);
    expect(betResponse.status).toBe(201);

    await entityManager.getConnection().execute(
      'update wager_transactions set next_attempt_at = now() where id = ?',
      [pendingBody.transactionId],
    );
    await app.get(PendingReferenceWorker).runOnce();

    const rows = await entityManager.getConnection().execute<{ status: string; balance_amount: string; credits: string }[]>(
      `select
        (select status from wager_transactions where id = ?) as status,
        (select balance_amount from wallets where id = ?) as balance_amount,
        (select count(*) from wallet_ledger_entries where transaction_id = ?) as credits`,
      [pendingBody.transactionId, wallet.id, pendingBody.transactionId],
    );
    expect(rows[0]).toEqual({ status: 'PROCESSED', balance_amount: '170.00', credits: '1' });
  });

  test('expires a pending WIN after the TTL and publishes rejection event', async () => {
    const wallet = await createWallet('100.00');
    const response = await submit(wallet, {
      kind: 'WIN',
      referenceExternalTransactionId: `missing-reference-${v4()}`,
    }, `expire-${v4()}`);
    const body = await response.json();
    expect(response.status).toBe(202);

    await entityManager.getConnection().execute(
      `update wager_transactions
       set pending_since = now() - interval '16 minutes', next_attempt_at = now(), pending_attempts = 5
       where id = ?`,
      [body.transactionId],
    );
    await app.get(PendingReferenceWorker).runOnce();

    const rows = await entityManager.getConnection().execute<{ status: string; failure_code: string; ledger: string; rejected_events: string }[]>(
      `select
        (select status from wager_transactions where id = ?) as status,
        (select failure_code from wager_transactions where id = ?) as failure_code,
        (select count(*) from wallet_ledger_entries where transaction_id = ?) as ledger,
        (select count(*) from outbox_messages where aggregate_id = ? and event_type = 'WagerTransactionRejected') as rejected_events`,
      [body.transactionId, body.transactionId, body.transactionId, body.transactionId],
    );

    expect(rows[0]).toEqual({ status: 'REJECTED', failure_code: 'REFERENCE_NOT_FOUND', ledger: '0', rejected_events: '1' });
  });

  test('processes a due pending WIN once when two worker instances race', async () => {
    const secondModuleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const secondApp = secondModuleRef.createNestApplication();
    secondApp.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    await secondApp.listen(0);

    try {
      const wallet = await createWallet('100.00');
      const referenceExternalTransactionId = `bet-race-${v4()}`;
      const pendingResponse = await submit(wallet, {
        kind: 'WIN',
        referenceExternalTransactionId,
      }, `pending-race-${v4()}`);
      const pendingBody = await pendingResponse.json();
      expect(pendingResponse.status).toBe(202);

      const betResponse = await submit(wallet, {
        kind: 'BET',
        externalTransactionId: referenceExternalTransactionId,
        money: { amount: '10.00', currency: 'BRL' },
      }, `bet-race-${v4()}`);
      expect(betResponse.status).toBe(201);

      await entityManager.getConnection().execute(
        'update wager_transactions set next_attempt_at = now() where id = ?',
        [pendingBody.transactionId],
      );

      await Promise.all([
        app.get(PendingReferenceWorker).runOnce(1),
        secondApp.get(PendingReferenceWorker).runOnce(1),
      ]);

      const rows = await entityManager.getConnection().execute<{
        status: string;
        balance_amount: string;
        ledger_entries: string;
        processed_events: string;
      }[]>(
        `select
          (select status from wager_transactions where id = ?) as status,
          (select balance_amount from wallets where id = ?) as balance_amount,
          (select count(*) from wallet_ledger_entries where transaction_id = ?) as ledger_entries,
          (select count(*) from outbox_messages where aggregate_id = ? and event_type = 'WagerTransactionProcessed') as processed_events`,
        [pendingBody.transactionId, wallet.id, pendingBody.transactionId, pendingBody.transactionId],
      );

      expect(rows[0]).toEqual({
        status: 'PROCESSED',
        balance_amount: '170.00',
        ledger_entries: '1',
        processed_events: '1',
      });
    } finally {
      await secondApp.close();
    }
  });
});

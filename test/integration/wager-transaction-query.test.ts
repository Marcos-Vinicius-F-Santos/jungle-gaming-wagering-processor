import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { INestApplicationContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { EntityManager } from '@mikro-orm/postgresql';
import { v4, v7 } from 'uuid';

import { AppModule } from '../../src/app.module';
import { CreateWalletUseCase } from '../../src/modules/wallets/application/create-wallet.use-case';
import {
  WAGER_TRANSACTION_QUERY_REPOSITORY,
} from '../../src/modules/wagering/application/ports/wager-transaction-query-repository.port';
import type {
  WagerTransactionQueryRepository,
} from '../../src/modules/wagering/application/ports/wager-transaction-query-repository.port';
import { ProcessWagerTransactionUseCase } from '../../src/modules/wagering/application/process-wager-transaction.use-case';
import { Money } from '../../src/shared/domain/money';

describe('PostgreSQL wager transaction query', () => {
  let app: INestApplicationContext;
  let entityManager: EntityManager;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef;
    entityManager = app.get(EntityManager);
  });

  afterAll(async () => {
    await app.close();
  });

  test('reads opening and processed transactions by both identities without secrets', async () => {
    const createWallet = app.get(CreateWalletUseCase);
    const processTransaction = app.get(ProcessWagerTransactionUseCase);
    const query = app.get<WagerTransactionQueryRepository>(WAGER_TRANSACTION_QUERY_REPOSITORY);
    const playerId = v4();
    const wallet = await createWallet.execute({
      playerId,
      initialBalance: Money.of('100.00', 'BRL'),
    });
    const externalTransactionId = `query-bet-${v4()}`;
    const result = await processTransaction.execute({
      providerId: 'query-provider',
      externalTransactionId,
      idempotencyKey: `query-key-${v4()}`,
      playerId,
      walletId: wallet.id,
      roundId: 'query-round',
      gameId: 'query-game',
      kind: 'BET',
      money: { amount: '10.00', currency: 'BRL' },
    });

    expect(result.status).toBe('PROCESSED');
    if (result.status !== 'PROCESSED') throw new Error('expected processed transaction');

    const openingRows = await entityManager.getConnection().execute<{ id: string }[]>(
      `select id from wager_transactions where wallet_id = ? and kind = 'OPENING' limit 1`,
      [wallet.id],
    );
    const opening = await query.findById(openingRows[0]!.id);
    const betById = await query.findById(result.transactionId);
    const betByExternal = await query.findByProviderExternalId('query-provider', externalTransactionId);

    expect(opening?.kind).toBe('OPENING');
    expect(opening?.status).toBe('PROCESSED');
    expect(betById).toEqual(betByExternal);
    expect(betById?.amount).toBe('10.00');
    expect(betById?.resultBalanceAmount).toBe('90.00');
    expect('payloadHash' in (betById ?? {})).toBe(false);
    expect('idempotencyKey' in (betById ?? {})).toBe(false);
    expect(await query.findByProviderExternalId('other-provider', externalTransactionId)).toBeNull();

    const fixtures = [
      { kind: 'WIN', status: 'PENDING', failureCode: null, pending: false },
      { kind: 'WIN', status: 'PENDING_REFERENCE', failureCode: null, pending: true },
      { kind: 'LOSS', status: 'PROCESSED', failureCode: null, pending: false },
      { kind: 'REFUND', status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS', pending: false },
      { kind: 'ROLLBACK', status: 'FAILED', failureCode: 'LOCK_RETRY_EXHAUSTED', pending: false },
    ] as const;
    for (const fixture of fixtures) {
      const fixtureId = v7();
      const fixtureExternalId = `query-${fixture.kind}-${v4()}`;
      const createdAt = new Date('2026-10-16T12:10:00.000Z');
      await entityManager.getConnection().execute(
        `insert into wager_transactions (
          id, provider_id, external_transaction_id, idempotency_key, payload_hash,
          wallet_id, player_id, round_id, game_id, reference_external_transaction_id,
          reference_transaction_id, pending_since, next_attempt_at, pending_attempts,
          result_balance_amount, result_balance_currency, kind, amount, currency,
          status, failure_code, created_at, processed_at
        ) values (?, ?, ?, null, null, ?, ?, ?, ?, null, null, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          fixtureId,
          'query-fixture-provider',
          fixtureExternalId,
          wallet.id,
          playerId,
          'fixture-round',
          'fixture-game',
          fixture.pending ? createdAt : null,
          fixture.pending ? new Date('2099-10-16T12:11:00.000Z') : null,
          fixture.pending ? 1 : 0,
          fixture.status === 'PROCESSED' ? '90.00' : null,
          fixture.status === 'PROCESSED' ? 'BRL' : null,
          fixture.kind,
          '5.00',
          'BRL',
          fixture.status,
          fixture.failureCode,
          createdAt,
          fixture.status === 'PROCESSED' ? createdAt : null,
        ],
      );

      const byId = await query.findById(fixtureId);
      const byExternal = await query.findByProviderExternalId('query-fixture-provider', fixtureExternalId);
      expect(byId?.kind).toBe(fixture.kind);
      expect(byId?.status).toBe(fixture.status);
      expect(byId).toEqual(byExternal);
    }
  });
});

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { INestApplicationContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { EntityManager } from '@mikro-orm/postgresql';
import { v4 } from 'uuid';

import { AppModule } from '../../src/app.module';
import { CreateWalletUseCase } from '../../src/modules/wallets/application/create-wallet.use-case';
import { ProcessWagerTransactionUseCase } from '../../src/modules/wagering/application/process-wager-transaction.use-case';
import { Money } from '../../src/shared/domain/money';

describe('double-entry ledger idempotency', () => {
  let app: INestApplicationContext;
  let entityManager: EntityManager;

  beforeAll(async () => {
    app = await Test.createTestingModule({ imports: [AppModule] }).compile();
    entityManager = app.get(EntityManager);
  });

  afterAll(async () => {
    await app.close();
  });

  test('creates one journal and two postings for fifty concurrent replays', async () => {
    const wallet = await app.get(CreateWalletUseCase).execute({ playerId: v4(), initialBalance: Money.of('100.00', 'USD') });
    const command = {
      providerId: 'ledger-idempotency',
      externalTransactionId: `bet-${v4()}`,
      idempotencyKey: `key-${v4()}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'ledger-idempotency-round',
      gameId: 'ledger-idempotency-game',
      kind: 'BET' as const,
      money: { amount: '25.00', currency: 'USD' },
    };
    const process = app.get(ProcessWagerTransactionUseCase);
    const results = await Promise.all(Array.from({ length: 50 }, () => process.execute(command)));
    const transactionIds = new Set(results.map((result) => result.transactionId));

    expect(transactionIds.size).toBe(1);
    expect(results.filter((result) => result.status === 'PROCESSED')).toHaveLength(50);

    const rows = await entityManager.getConnection().execute<{ journals: string; postings: string }[]>(
      `select count(distinct j.id)::text as journals, count(p.id)::text as postings
         from ledger_journal_entries j
         join ledger_postings p on p.journal_entry_id = j.id
        where j.transaction_id = ?
          and j.effect_type = 'BET'`,
      [results[0].transactionId],
    );
    expect(rows[0]).toEqual({ journals: '1', postings: '2' });
  });
});

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { INestApplicationContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { EntityManager } from '@mikro-orm/postgresql';
import { v7 } from 'uuid';

import { AppModule } from '../../src/app.module';
import { LedgerEffectRecorder } from '../../src/modules/ledger/application/ledger-effect-recorder';
import { LedgerAccountPolicy } from '../../src/modules/ledger/domain/ledger-policy';
import { MikroOrmDoubleEntryLedgerRepository } from '../../src/modules/ledger/infrastructure/persistence/mikro-orm-double-entry-ledger.repository';
import { Money } from '../../src/shared/domain/money';

describe('ledger effect recorder', () => {
  let app: INestApplicationContext;
  let entityManager: EntityManager;
  let recorder: LedgerEffectRecorder;
  let repository: MikroOrmDoubleEntryLedgerRepository;

  beforeAll(async () => {
    app = await Test.createTestingModule({ imports: [AppModule] }).compile();
    entityManager = app.get(EntityManager);
    repository = new MikroOrmDoubleEntryLedgerRepository(entityManager);
    recorder = new LedgerEffectRecorder(repository);
  });

  afterAll(async () => {
    await app.close();
  });

  test('records a policy-driven effect in the active Unit of Work', async () => {
    const walletId = v7();
    const transactionId = v7();
    const playerId = v7();
    const now = new Date();
    await entityManager.getConnection().execute(
      `insert into wallets (id, player_id, currency) values (?, ?, 'USD')`,
      [walletId, playerId],
    );
    await entityManager.getConnection().execute(
      `insert into wager_transactions (id, provider_id, external_transaction_id, wallet_id, player_id, kind, amount, currency, status)
       values (?, 'recorder-test', ?, ?, ?, 'BET', 10.00, 'USD', 'PROCESSED')`,
      [transactionId, `external-${transactionId}`, walletId, playerId],
    );

    const journal = await entityManager.transactional(() => recorder.record({
      transactionId,
      effectType: 'BET',
      walletId,
      currency: 'USD',
      amount: Money.of('10.00', 'USD'),
      occurredAt: now,
    }));

    expect(journal?.isBalanced()).toBe(true);
    expect(journal?.postings.map((posting) => posting.direction)).toEqual(['CREDIT', 'DEBIT']);
    expect(journal?.postings.map((posting) => posting.money.amount)).toEqual(['10.00', '10.00']);
    expect(await repository.findJournalByTransactionEffect(transactionId, 'BET')).toBeDefined();
  });

  test('does not create a journal for LOSS', async () => {
    const journal = await recorder.record({
      transactionId: v7(),
      effectType: 'LOSS',
      walletId: v7(),
      currency: 'USD',
      amount: Money.of('1.00', 'USD'),
      occurredAt: new Date(),
    });

    expect(journal).toBeUndefined();
    expect(LedgerAccountPolicy.createPlan({
      effectType: 'LOSS',
      walletId: v7(),
      currency: 'USD',
      amount: Money.of('1.00', 'USD'),
    }).postings).toEqual([]);
  });
});

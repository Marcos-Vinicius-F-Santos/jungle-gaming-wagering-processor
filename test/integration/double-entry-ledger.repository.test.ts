import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { INestApplicationContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { EntityManager } from '@mikro-orm/postgresql';
import { v7 } from 'uuid';

import { AppModule } from '../../src/app.module';
import { LedgerAccount } from '../../src/modules/ledger/domain/ledger-account';
import { JournalEntry } from '../../src/modules/ledger/domain/journal-entry';
import { Posting } from '../../src/modules/ledger/domain/posting';
import { MikroOrmDoubleEntryLedgerRepository } from '../../src/modules/ledger/infrastructure/persistence/mikro-orm-double-entry-ledger.repository';
import { Money } from '../../src/shared/domain/money';

describe('PostgreSQL double-entry ledger repository', () => {
  let app: INestApplicationContext;
  let entityManager: EntityManager;
  let repository: MikroOrmDoubleEntryLedgerRepository;

  beforeAll(async () => {
    app = await Test.createTestingModule({ imports: [AppModule] }).compile();
    entityManager = app.get(EntityManager);
    repository = new MikroOrmDoubleEntryLedgerRepository(entityManager);
  });

  afterAll(async () => {
    await app.close();
  });

  test('persists and rehydrates accounts, journals and postings without exposing ORM entities', async () => {
    const walletId = v7();
    const playerId = v7();
    const transactionId = v7();
    const walletAccount = LedgerAccount.create({
      id: v7(),
      accountKey: `wallet:BRL:${walletId}`,
      accountType: 'WALLET',
      currency: 'BRL',
      walletId,
      policyVersion: 'ledger-v1',
      createdAt: new Date(),
    });
    const systemAccount = LedgerAccount.create({
      id: v7(),
      accountKey: `game_stake:BRL:${transactionId}`,
      accountType: 'GAME_STAKE',
      currency: 'BRL',
      policyVersion: 'ledger-v1',
      createdAt: new Date(),
    });

    await entityManager.getConnection().execute(
      `insert into wallets (id, player_id, currency) values (?, ?, 'BRL')`,
      [walletId, playerId],
    );
    await entityManager.getConnection().execute(
      `insert into wager_transactions (id, provider_id, external_transaction_id, wallet_id, player_id, kind, amount, currency, status)
       values (?, 'repository-test', ?, ?, ?, 'BET', 10.00, 'BRL', 'PROCESSED')`,
      [transactionId, `external-${transactionId}`, walletId, playerId],
    );
    await repository.saveAccount(walletAccount);
    await repository.saveAccount(systemAccount);

    const journalId = v7();
    const amount = Money.of('10.00', 'BRL');
    const journal = JournalEntry.create({
      id: journalId,
      transactionId,
      effectType: 'BET',
      currency: 'BRL',
      policyVersion: 'ledger-v1',
      occurredAt: new Date(),
      postings: [
        Posting.create({ id: v7(), journalEntryId: journalId, accountId: walletAccount.id, walletId, direction: 'DEBIT', money: amount, createdAt: new Date() }),
        Posting.create({ id: v7(), journalEntryId: journalId, accountId: systemAccount.id, direction: 'CREDIT', money: amount, createdAt: new Date() }),
      ],
    });
    await repository.saveJournal(journal);

    const rehydrated = await repository.findJournalByTransactionEffect(transactionId, 'BET');
    const rehydratedAccount = await repository.findAccountByKey(walletAccount.accountKey);
    expect(rehydrated?.isBalanced()).toBe(true);
    expect(rehydrated?.postings).toHaveLength(2);
    expect(rehydrated?.policyVersion).toBe('ledger-v1');
    expect(rehydratedAccount?.accountType).toBe('WALLET');
    expect(rehydratedAccount?.walletId).toBe(walletId);
  });

  test('rolls back a partial account insertion inside the Unit of Work transaction', async () => {
    const account = LedgerAccount.create({
      id: v7(),
      accountKey: `rollback:BRL:${v7()}`,
      accountType: 'LEGACY_COUNTERPARTY',
      currency: 'BRL',
      policyVersion: 'legacy-v1',
      createdAt: new Date(),
    });

    await expect(entityManager.transactional(async () => {
      await repository.saveAccount(account);
      throw new Error('forced repository rollback');
    })).rejects.toThrow('forced repository rollback');
    await expect(repository.findAccountByKey(account.accountKey)).resolves.toBeUndefined();
  });
});

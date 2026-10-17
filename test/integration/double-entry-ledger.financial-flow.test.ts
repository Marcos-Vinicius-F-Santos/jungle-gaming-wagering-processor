import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { INestApplicationContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { EntityManager } from '@mikro-orm/postgresql';
import { v4 } from 'uuid';

import { AppModule } from '../../src/app.module';
import { CreateWalletUseCase } from '../../src/modules/wallets/application/create-wallet.use-case';
import { ProcessWagerTransactionUseCase } from '../../src/modules/wagering/application/process-wager-transaction.use-case';
import { Money } from '../../src/shared/domain/money';

describe('double-entry financial flow', () => {
  let app: INestApplicationContext;
  let entityManager: EntityManager;

  beforeAll(async () => {
    app = await Test.createTestingModule({ imports: [AppModule] }).compile();
    entityManager = app.get(EntityManager);
  });

  afterAll(async () => {
    await app.close();
  });

  test('creates balanced OPENING, BET and WIN journals while LOSS remains non-patrimonial', async () => {
    const createWallet = app.get(CreateWalletUseCase);
    const process = app.get(ProcessWagerTransactionUseCase);
    const wallet = await createWallet.execute({ playerId: v4(), initialBalance: Money.of('100.00', 'BRL') });

    const bet = await process.execute({
      providerId: 'ledger-flow',
      externalTransactionId: `bet-${v4()}`,
      idempotencyKey: `key-${v4()}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'ledger-flow-round',
      gameId: 'ledger-flow-game',
      kind: 'BET',
      money: { amount: '10.00', currency: 'BRL' },
    });
    const win = await process.execute({
      providerId: 'ledger-flow',
      externalTransactionId: `win-${v4()}`,
      idempotencyKey: `key-${v4()}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'ledger-flow-round',
      gameId: 'ledger-flow-game',
      kind: 'WIN',
      money: { amount: '15.00', currency: 'BRL' },
    });
    const loss = await process.execute({
      providerId: 'ledger-flow',
      externalTransactionId: `loss-${v4()}`,
      idempotencyKey: `key-${v4()}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'ledger-flow-round',
      gameId: 'ledger-flow-game',
      kind: 'LOSS',
      money: { amount: '15.00', currency: 'BRL' },
    });

    expect(bet.status).toBe('PROCESSED');
    expect(win.status).toBe('PROCESSED');
    if (win.status !== 'PROCESSED') throw new Error('expected WIN to be processed');
    expect(win.balance).toEqual({ amount: '105.00', currency: 'BRL' });
    expect(loss).toMatchObject({ status: 'PROCESSED', balance: { amount: '105.00', currency: 'BRL' } });

    const rows = await entityManager.getConnection().execute<{
      effect_type: string;
      journal_count: string;
      debit_total: string;
      credit_total: string;
    }[]>(
      `select j.effect_type,
              count(distinct j.id)::text as journal_count,
              coalesce(sum(case when p.direction = 'DEBIT' then p.amount else 0 end), 0)::text as debit_total,
              coalesce(sum(case when p.direction = 'CREDIT' then p.amount else 0 end), 0)::text as credit_total
         from ledger_journal_entries j
         join ledger_postings p on p.journal_entry_id = j.id
        where exists (
          select 1
            from ledger_postings wallet_posting
           where wallet_posting.journal_entry_id = j.id
             and wallet_posting.wallet_id = ?
        )
        group by j.effect_type
        order by j.effect_type`,
      [wallet.id],
    );

    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.effect_type)).toEqual(['BET', 'OPENING', 'WIN']);
    expect(rows.every((row) => row.journal_count === '1' && row.debit_total === row.credit_total)).toBe(true);
  });
});

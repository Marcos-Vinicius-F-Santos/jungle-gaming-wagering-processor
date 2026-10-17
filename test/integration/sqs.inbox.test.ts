import 'reflect-metadata';

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { EntityManager } from '@mikro-orm/postgresql';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { v4 } from 'uuid';

process.env.SQS_ENABLED = 'false';
process.env.SQS_ENDPOINT = process.env.SQS_ENDPOINT ?? 'http://localhost:4566';
process.env.SQS_QUEUE_URL = process.env.SQS_QUEUE_URL
  ?? 'http://localhost:4566/000000000000/wager-transactions.fifo';
process.env.SQS_DLQ_URL = process.env.SQS_DLQ_URL
  ?? 'http://localhost:4566/000000000000/wager-transactions-dlq.fifo';

import { AppModule } from '../../src/app.module';
import { SqsMessageConsumerAdapter } from '../../src/modules/messaging/sqs/infrastructure/sqs-message-consumer.adapter';
import { SqsWagerTransactionConsumer } from '../../src/modules/messaging/sqs/application/sqs-wager-transaction.consumer';

describe('SQS Inbox integration', () => {
  let app: INestApplication;
  let entityManager: EntityManager;
  let sqs: SQSClient;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    await app.listen(0);
    entityManager = app.get(EntityManager);
    sqs = new SQSClient({
      region: 'us-east-1',
      endpoint: 'http://localhost:4566',
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    });
  });

  afterAll(async () => {
    sqs.destroy();
    await app.close();
  });

  test('processes a FIFO message, commits Inbox and deletes only after commit', async () => {
    const playerId = v4();
    const walletId = v4();
    const walletResponse = await fetch(`${await app.getUrl()}/wallets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ playerId, id: walletId, initialBalance: { amount: '100.00', currency: 'BRL' } }),
    });
    expect(walletResponse.status).toBe(201);
    const wallet = await walletResponse.json() as { id: string };
    const messageId = `sqs-${v4()}`;
    const body = JSON.stringify({
      messageId,
      type: 'WagerTransactionRequested',
      occurredAt: new Date().toISOString(),
      data: {
        providerId: `provider-sqs-${v4()}`,
        externalTransactionId: `external-sqs-${v4()}`,
        idempotencyKey: `idempotency-sqs-${v4()}`,
        playerId,
        walletId: wallet.id,
        roundId: 'round-sqs',
        gameId: 'game-sqs',
        kind: 'BET',
        money: { amount: '25.00', currency: 'BRL' },
      },
    });

    await sqs.send(new SendMessageCommand({
      QueueUrl: process.env.SQS_QUEUE_URL,
      MessageBody: body,
      MessageGroupId: 'wallet-sqs',
      MessageDeduplicationId: `dedupe-${v4()}`,
    }));

    const adapter = app.get(SqsMessageConsumerAdapter);
    const messages = await adapter.receive();
    expect(messages).toHaveLength(1);
    const outcome = await app.get(SqsWagerTransactionConsumer).processMessage(messages[0]);
    expect(outcome.action).toBe('ACK');

    const rows = await entityManager.getConnection().execute<{
      balance_amount: string;
      transactions: string;
      ledger: string;
      journals: string;
      inbox_status: string;
    }[]>(
      `select
        (select balance_amount from wallets where id = ?) as balance_amount,
        (select count(*) from wager_transactions where wallet_id = ? and kind = 'BET') as transactions,
        (select count(*) from wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT') as ledger,
        (select count(*)
         from ledger_journal_entries journal
         join ledger_postings posting on posting.journal_entry_id = journal.id
         where journal.transaction_id in (select id from wager_transactions where wallet_id = ? and kind = 'BET')) as journals,
        (select status from inbox_messages where consumer_name = 'wager-transaction-consumer-v1' and message_id = ?) as inbox_status`,
      [wallet.id, wallet.id, wallet.id, wallet.id, messageId],
    );
    expect(rows[0]).toEqual({ balance_amount: '75.00', transactions: '1', ledger: '1', journals: '2', inbox_status: 'PROCESSED' });
  });
});

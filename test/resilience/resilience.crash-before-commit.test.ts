import { randomUUID } from 'node:crypto';

import {
  PurgeQueueCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { afterAll, describe, expect, test } from 'bun:test';
import { Pool } from 'pg';
import { v7 } from 'uuid';

const queueUrl = process.env.RESILIENCE_QUEUE_URL
  ?? 'http://127.0.0.1:14566/000000000000/wager-transactions.fifo';
const consumerName = 'wager-transaction-consumer-v1';
const sqs = new SQSClient({
  region: 'us-east-1',
  endpoint: process.env.RESILIENCE_SQS_ENDPOINT ?? 'http://127.0.0.1:14566',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
});
const pool = new Pool({
  connectionString: process.env.RESILIENCE_DATABASE_URL
    ?? 'postgresql://wagering:wagering@127.0.0.1:15432/wagering',
});

describe('crash before commit', () => {
  afterAll(async () => {
    sqs.destroy();
    await pool.end();
  });

  test('rolls back the first process and completes after lease recovery', async () => {
    await sqs.send(new PurgeQueueCommand({ QueueUrl: queueUrl }));
    const walletId = v7();
    const playerId = v7();
    const messageId = `before-commit-${randomUUID()}`;
    const externalTransactionId = `external-${messageId}`;
    const client = await pool.connect();
    try {
      await client.query(
        `insert into wallets (id, player_id, currency, balance_amount, version)
         values ($1, $2, 'BRL', 100.00, 1)`,
        [walletId, playerId],
      );
    } finally {
      client.release();
    }

    await sqs.send(new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify({
        type: 'WagerTransactionRequested',
        messageId,
        occurredAt: new Date().toISOString(),
        data: {
          providerId: `provider-${messageId}`,
          externalTransactionId,
          idempotencyKey: `idempotency-${messageId}`,
          playerId,
          walletId,
          roundId: `round-${messageId}`,
          gameId: 'resilience-before-commit',
          kind: 'BET',
          money: { amount: '10.00', currency: 'BRL' },
        },
      }),
      MessageGroupId: 'resilience-before-commit',
      MessageDeduplicationId: messageId,
    }));

    const deadline = Date.now() + 20_000;
    let snapshot: Record<string, string> | undefined;
    while (Date.now() < deadline) {
      const read = await pool.query(
        `select
           (select balance_amount::text from wallets where id = $1) as balance,
           (select count(*)::text from wager_transactions where external_transaction_id = $2) as transactions,
           (select count(*)::text from wallet_ledger_entries where wallet_id = $1) as ledger,
           (select status from inbox_messages where consumer_name = $3 and message_id = $4) as inbox_status`,
        [walletId, externalTransactionId, consumerName, messageId],
      );
      snapshot = read.rows[0];
      if (snapshot?.inbox_status === 'PROCESSED') break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    expect(snapshot?.balance).toBe('90.00');
    expect(snapshot?.transactions).toBe('1');
    expect(snapshot?.ledger).toBe('1');
    expect(snapshot?.inbox_status).toBe('PROCESSED');
  }, 30_000);
});

import { randomUUID } from 'node:crypto';

import {
  GetQueueAttributesCommand,
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

describe('three-instance concurrency', () => {
  afterAll(async () => {
    sqs.destroy();
    await pool.end();
  });

  test('applies one effect for a duplicate and independent effects for different wallets', async () => {
    await sqs.send(new PurgeQueueCommand({ QueueUrl: queueUrl }));

    const shared = await createWallet();
    const walletA = await createWallet();
    const walletB = await createWallet();
    const sharedMessageId = `duplicate-${randomUUID()}`;

    const sharedBody = buildBody(sharedMessageId, shared, `shared-${randomUUID()}`);
    const bodyA = buildBody(`wallet-a-${randomUUID()}`, walletA, `wallet-a-${randomUUID()}`);
    const bodyB = buildBody(`wallet-b-${randomUUID()}`, walletB, `wallet-b-${randomUUID()}`);

    await Promise.all([
      send(sharedBody, `dedupe-a-${randomUUID()}`),
      send(sharedBody, `dedupe-b-${randomUUID()}`),
      send(bodyA, `dedupe-a-${randomUUID()}`),
      send(bodyB, `dedupe-b-${randomUUID()}`),
    ]);

    const sharedSnapshot = await waitForSnapshot(shared, sharedMessageId, 2);
    const snapshotA = await waitForSnapshot(walletA, bodyA.messageId, 2);
    const snapshotB = await waitForSnapshot(walletB, bodyB.messageId, 2);
    await waitForQueueDrain();

    expect(sharedSnapshot.balance).toBe('90.00');
    expect(sharedSnapshot.transactions).toBe(1);
    expect(sharedSnapshot.ledger).toBe(1);
    expect(sharedSnapshot.inboxStatus).toBe('PROCESSED');
    expect(sharedSnapshot.outbox).toBe(2);

    expect(snapshotA.balance).toBe('90.00');
    expect(snapshotA.transactions).toBe(1);
    expect(snapshotA.ledger).toBe(1);
    expect(snapshotB.balance).toBe('90.00');
    expect(snapshotB.transactions).toBe(1);
    expect(snapshotB.ledger).toBe(1);
  }, 30_000);
});

async function createWallet(): Promise<{ walletId: string; playerId: string }> {
  const walletId = v7();
  const playerId = v7();
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
  return { walletId, playerId };
}

function buildBody(
  messageId: string,
  wallet: { walletId: string; playerId: string },
  externalTransactionId: string,
): { messageId: string; body: string } {
  return {
    messageId,
    body: JSON.stringify({
      type: 'WagerTransactionRequested',
      messageId,
      occurredAt: new Date().toISOString(),
      data: {
        providerId: `provider-${messageId}`,
        externalTransactionId,
        idempotencyKey: `idempotency-${messageId}`,
        playerId: wallet.playerId,
        walletId: wallet.walletId,
        roundId: `round-${messageId}`,
        gameId: 'resilience-concurrency',
        kind: 'BET',
        money: { amount: '10.00', currency: 'BRL' },
      },
    }),
  };
}

async function send(body: { body: string }, deduplicationId: string): Promise<void> {
  await sqs.send(new SendMessageCommand({
    QueueUrl: queueUrl,
    MessageBody: body.body,
    MessageGroupId: 'resilience-concurrency',
    MessageDeduplicationId: deduplicationId,
  }));
}

async function waitForSnapshot(
  wallet: { walletId: string },
  messageId: string,
  expectedOutbox: number,
): Promise<{ balance: string; transactions: number; ledger: number; inboxStatus: string; outbox: number }> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const client = await pool.connect();
    try {
      const result = await client.query(
        `select
           (select balance_amount::text from wallets where id = $1) as balance,
           (select count(*)::text from wager_transactions where wallet_id = $1) as transactions,
           (select count(*)::text from wallet_ledger_entries where wallet_id = $1) as ledger,
           (select status from inbox_messages where consumer_name = $2 and message_id = $3) as inbox_status,
           (select count(*)::text from outbox_messages where aggregate_id in
             (select id from wager_transactions where wallet_id = $1)) as outbox`,
        [wallet.walletId, consumerName, messageId],
      );
      const row = result.rows[0];
      const snapshot = {
        balance: row?.balance ?? 'missing',
        transactions: Number(row?.transactions ?? 0),
        ledger: Number(row?.ledger ?? 0),
        inboxStatus: row?.inbox_status ?? 'missing',
        outbox: Number(row?.outbox ?? 0),
      };
      if (snapshot.inboxStatus === 'PROCESSED' && snapshot.outbox === expectedOutbox) return snapshot;
    } finally {
      client.release();
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Concurrency scenario timed out for ${messageId}`);
}

async function waitForQueueDrain(): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = await sqs.send(new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
    }));
    const visible = Number(result.Attributes?.ApproximateNumberOfMessages ?? 0);
    const inFlight = Number(result.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0);
    if (visible === 0 && inFlight === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Concurrency scenario queue did not drain');
}

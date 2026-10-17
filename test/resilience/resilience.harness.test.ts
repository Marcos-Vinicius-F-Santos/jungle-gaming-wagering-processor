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
const databaseUrl = process.env.RESILIENCE_DATABASE_URL
  ?? 'postgresql://wagering:wagering@127.0.0.1:15432/wagering';
const consumerName = 'wager-transaction-consumer-v1';

interface ScenarioSnapshot {
  readonly runId: string;
  readonly walletId: string;
  readonly messageId: string;
  readonly walletBalance: string;
  readonly ledgerCount: number;
  readonly transactionCount: number;
  readonly inboxStatus: string;
  readonly outboxCount: number;
}

const sqs = new SQSClient({
  region: 'us-east-1',
  endpoint: process.env.RESILIENCE_SQS_ENDPOINT ?? 'http://127.0.0.1:14566',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
});
const pool = new Pool({ connectionString: databaseUrl });

describe('resilience scenario harness', () => {
  afterAll(async () => {
    sqs.destroy();
    await pool.end();
  });

  test('runs two isolated executions with stable invariants', async () => {
    await sqs.send(new PurgeQueueCommand({ QueueUrl: queueUrl }));

    const first = await runScenario();
    const second = await runScenario();

    expect(first.walletBalance).toBe('90.00');
    expect(first.ledgerCount).toBe(1);
    expect(first.transactionCount).toBe(1);
    expect(first.inboxStatus).toBe('PROCESSED');
    expect(first.outboxCount).toBe(2);

    expect(second.walletBalance).toBe('90.00');
    expect(second.ledgerCount).toBe(1);
    expect(second.transactionCount).toBe(1);
    expect(second.inboxStatus).toBe('PROCESSED');
    expect(second.outboxCount).toBe(2);
    expect(second.runId).not.toBe(first.runId);
    expect(second.messageId).not.toBe(first.messageId);
  }, 30_000);
});

async function runScenario(): Promise<ScenarioSnapshot> {
  const runId = randomUUID();
  const walletId = v7();
  const playerId = v7();
  const messageId = `resilience-${runId}`;
  const externalTransactionId = `external-${runId}`;
  const idempotencyKey = `idempotency-${runId}`;
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

  const body = JSON.stringify({
    type: 'WagerTransactionRequested',
    messageId,
    occurredAt: new Date().toISOString(),
    correlationId: `correlation-${runId}`,
    data: {
      providerId: `provider-${runId}`,
      externalTransactionId,
      idempotencyKey,
      playerId,
      walletId,
      roundId: `round-${runId}`,
      gameId: 'resilience-harness',
      kind: 'BET',
      money: { amount: '10.00', currency: 'BRL' },
    },
  });

  await sqs.send(new SendMessageCommand({
    QueueUrl: queueUrl,
    MessageBody: body,
    MessageGroupId: `resilience-${runId}`,
    MessageDeduplicationId: messageId,
  }));

  return waitForSnapshot({ runId, walletId, messageId, externalTransactionId });
}

async function waitForSnapshot(input: {
  runId: string;
  walletId: string;
  messageId: string;
  externalTransactionId: string;
}): Promise<ScenarioSnapshot> {
  const deadline = Date.now() + 20_000;
  let lastSnapshot: ScenarioSnapshot | undefined;

  while (Date.now() < deadline) {
    const client = await pool.connect();
    try {
      const wallet = await client.query(
        'select balance_amount as balance from wallets where id = $1',
        [input.walletId],
      );
      const transactions = await client.query(
        'select min(id::text) as id, count(*)::text as count from wager_transactions where external_transaction_id = $1',
        [input.externalTransactionId],
      );
      const ledger = await client.query(
        'select count(*)::text as count from wallet_ledger_entries where wallet_id = $1',
        [input.walletId],
      );
      const inbox = await client.query(
        'select status from inbox_messages where consumer_name = $1 and message_id = $2',
        [consumerName, input.messageId],
      );
      const outbox = await client.query(
        `select count(*)::text as count
         from outbox_messages
         where aggregate_id = $1`,
        [transactions.rows[0]?.id ?? null],
      );

      lastSnapshot = {
        runId: input.runId,
        walletId: input.walletId,
        messageId: input.messageId,
        walletBalance: wallet.rows[0]?.balance ?? 'missing',
        ledgerCount: Number(ledger.rows[0]?.count ?? 0),
        transactionCount: Number(transactions.rows[0]?.count ?? 0),
        inboxStatus: inbox.rows[0]?.status ?? 'missing',
        outboxCount: Number(outbox.rows[0]?.count ?? 0),
      };
      if (lastSnapshot.inboxStatus === 'PROCESSED' && lastSnapshot.outboxCount === 2) {
        return lastSnapshot;
      }
    } finally {
      client.release();
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`Resilience scenario timed out: ${JSON.stringify(lastSnapshot)}`);
}

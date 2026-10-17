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

const root = process.cwd();
const baseCompose = 'docker-compose.resilience.yml';
const failureCompose = 'docker-compose.resilience.failures.yml';
const resilienceProject = 'jungle-gaming-resilience';
const queueUrl = process.env.RESILIENCE_QUEUE_URL
  ?? 'http://127.0.0.1:14566/000000000000/wager-transactions.fifo';
const dlqUrl = process.env.RESILIENCE_QUEUE_URL
  ?.replace('wager-transactions.fifo', 'wager-transactions-dlq.fifo')
  ?? 'http://127.0.0.1:14566/000000000000/wager-transactions-dlq.fifo';
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
pool.on('error', () => undefined);

describe('real-process failure classification', () => {
  afterAll(async () => {
    sqs.destroy();
    await pool.end();
  });

  test('recovers transient database failure and sends poison message to DLQ', async () => {
    await sqs.send(new PurgeQueueCommand({ QueueUrl: queueUrl }));
    await sqs.send(new PurgeQueueCommand({ QueueUrl: dlqUrl }));

    const walletId = v7();
    const playerId = v7();
    const messageId = `transient-${randomUUID()}`;
    await pool.query(
      `insert into wallets (id, player_id, currency, balance_amount, version)
       values ($1, $2, 'BRL', 100.00, 1)`,
      [walletId, playerId],
    );

    const stopped = runDocker(['compose', '-f', baseCompose, 'stop', 'postgres']);
    if (stopped.status !== 0) throw new Error(`Could not stop PostgreSQL: ${stopped.stderr}`);

    await sqs.send(new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: validBody(messageId, walletId, playerId),
      MessageGroupId: 'resilience-transient',
      MessageDeduplicationId: messageId,
    }));
    await new Promise((resolve) => setTimeout(resolve, 3_000));

    const started = runDocker(['compose', '-f', baseCompose, '-f', failureCompose, 'start', 'postgres']);
    if (started.status !== 0) throw new Error(`Could not start PostgreSQL: ${started.stderr}`);

    const transientSnapshot = await waitForProcessed(walletId, messageId, `external-${messageId}`);
    expect(transientSnapshot.balance).toBe('90.00');
    expect(transientSnapshot.transactions).toBe(1);
    expect(transientSnapshot.inboxStatus).toBe('PROCESSED');

    const poisonId = `poison-${randomUUID()}`;
    await sqs.send(new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify({ type: 'Unsupported', messageId: poisonId }),
      MessageGroupId: 'resilience-poison',
      MessageDeduplicationId: poisonId,
    }));

    const poison = await waitForPermanentFailure(poisonId, walletId);
    expect(poison.status).toBe('FAILED_PERMANENT');
    expect(poison.balance).toBe('90.00');
    expect(poison.transactions).toBe(1);
    expect(await waitForDlqMessage()).toBe(true);
  }, 45_000);
});

function validBody(messageId: string, walletId: string, playerId: string): string {
  return JSON.stringify({
    type: 'WagerTransactionRequested',
    messageId,
    occurredAt: new Date().toISOString(),
    data: {
      providerId: `provider-${messageId}`,
      externalTransactionId: `external-${messageId}`,
      idempotencyKey: `idempotency-${messageId}`,
      playerId,
      walletId,
      roundId: `round-${messageId}`,
      gameId: 'resilience-failures',
      kind: 'BET',
      money: { amount: '10.00', currency: 'BRL' },
    },
  });
}

async function waitForProcessed(walletId: string, messageId: string, externalId: string): Promise<{
  balance: string;
  transactions: number;
  inboxStatus: string;
}> {
  const deadline = Date.now() + 25_000;
  let snapshot = { balance: 'missing', transactions: 0, inboxStatus: 'missing' };
  while (Date.now() < deadline) {
    try {
      const result = await pool.query(
        `select
           (select balance_amount::text from wallets where id = $1) as balance,
           (select count(*)::text from wager_transactions where external_transaction_id = $2) as transactions,
           (select status from inbox_messages where consumer_name = $3 and message_id = $4) as inbox_status`,
        [walletId, externalId, consumerName, messageId],
      );
      const row = result.rows[0];
      snapshot = {
        balance: row?.balance ?? 'missing',
        transactions: Number(row?.transactions ?? 0),
        inboxStatus: row?.inbox_status ?? 'missing',
      };
      if (snapshot.inboxStatus === 'PROCESSED') return snapshot;
    } catch {
      // PostgreSQL is expected to be unavailable during the transient phase.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Transient scenario timed out: ${JSON.stringify(snapshot)}`);
}

async function waitForPermanentFailure(messageId: string, walletId: string): Promise<{ status: string; balance: string; transactions: number }> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const result = await pool.query(
      `select
         (select status from inbox_messages where consumer_name = $1 and message_id = $2) as status,
         (select balance_amount::text from wallets where id = $3) as balance,
         (select count(*)::text from wager_transactions where wallet_id = $3) as transactions`,
      [consumerName, messageId, walletId],
    );
    const row = result.rows[0];
    const snapshot = {
      status: row?.status ?? 'missing',
      balance: row?.balance ?? 'missing',
      transactions: Number(row?.transactions ?? 0),
    };
    if (snapshot.status === 'FAILED_PERMANENT') return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Poison message did not become permanent: ${messageId}`);
}

async function waitForDlqMessage(): Promise<boolean> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const result = await sqs.send(new GetQueueAttributesCommand({
      QueueUrl: dlqUrl,
      AttributeNames: ['ApproximateNumberOfMessages'],
    }));
    if (Number(result.Attributes?.ApproximateNumberOfMessages ?? 0) >= 1) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

function runDocker(args: string[]): { status: number; stderr: string } {
  const command = args[0] === 'compose'
    ? ['docker', 'compose', '-p', resilienceProject, ...args.slice(1)]
    : ['docker', ...args];
  const result = Bun.spawnSync({ cmd: command, cwd: root });
  return { status: result.exitCode, stderr: new TextDecoder().decode(result.stderr) };
}

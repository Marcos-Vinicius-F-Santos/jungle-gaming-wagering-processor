import { randomUUID } from 'node:crypto';

import {
  PurgeQueueCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { afterAll, describe, expect, test } from 'bun:test';
import { Pool } from 'pg';
import { v7 } from 'uuid';

const root = process.cwd();
const baseCompose = 'docker-compose.resilience.yml';
const faultCompose = 'docker-compose.resilience.after-commit.yml';
const resilienceProject = 'jungle-gaming-resilience';
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

describe('crash after commit before ack', () => {
  afterAll(async () => {
    sqs.destroy();
    await pool.end();
  });

  test('replays after the crash without a second financial effect', async () => {
    await sqs.send(new PurgeQueueCommand({ QueueUrl: queueUrl }));
    const walletId = v7();
    const playerId = v7();
    const messageId = `after-commit-${randomUUID()}`;
    const externalTransactionId = `external-${messageId}`;
    await pool.query(
      `insert into wallets (id, player_id, currency, balance_amount, version)
       values ($1, $2, 'BRL', 100.00, 1)`,
      [walletId, playerId],
    );

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
          gameId: 'resilience-after-commit',
          kind: 'BET',
          money: { amount: '10.00', currency: 'BRL' },
        },
      }),
      MessageGroupId: 'resilience-after-commit',
      MessageDeduplicationId: messageId,
    }));

    await waitForFaultedContainer();
    const restart = runDocker(['compose', '-f', baseCompose, 'up', '-d']);
    if (restart.status !== 0) throw new Error(`Could not restart base composition: ${restart.stderr}`);

    const deadline = Date.now() + 20_000;
    let snapshot: Record<string, string> | undefined;
    while (Date.now() < deadline) {
      const read = await pool.query(
        `select
           (select balance_amount::text from wallets where id = $1) as balance,
           (select count(*)::text from wager_transactions where external_transaction_id = $2) as transactions,
           (select count(*)::text from wallet_ledger_entries where wallet_id = $1) as ledger,
           (select status from inbox_messages where consumer_name = $3 and message_id = $4) as inbox_status,
           (select count(*)::text from outbox_messages where aggregate_id in
             (select id from wager_transactions where external_transaction_id = $2)) as outbox`,
        [walletId, externalTransactionId, consumerName, messageId],
      );
      snapshot = read.rows[0];
      if (snapshot?.inbox_status === 'PROCESSED' && snapshot?.outbox === '2') break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    expect(snapshot?.balance).toBe('90.00');
    expect(snapshot?.transactions).toBe('1');
    expect(snapshot?.ledger).toBe('1');
    expect(snapshot?.inbox_status).toBe('PROCESSED');
    expect(snapshot?.outbox).toBe('2');
  }, 30_000);
});

async function waitForFaultedContainer(): Promise<void> {
  const idResult = runDocker(['compose', '-f', baseCompose, '-f', faultCompose, 'ps', '-q', 'resilience-app-1']);
  const containerId = idResult.stdout.trim();
  if (!containerId) throw new Error('Faulted app container was not found');

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const state = runDocker(['inspect', '--format', '{{.State.Status}}', containerId]).stdout.trim();
    if (state === 'exited') return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Fault injection did not terminate resilience-app-1');
}

function runDocker(args: string[]): { status: number; stdout: string; stderr: string } {
  const command = args[0] === 'compose'
    ? ['docker', 'compose', '-p', resilienceProject, ...args.slice(1)]
    : ['docker', ...args];
  const result = Bun.spawnSync({ cmd: command, cwd: root });
  return {
    status: result.exitCode,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

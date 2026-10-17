import { randomUUID } from 'node:crypto';

import { PurgeQueueCommand, SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { afterAll, describe, expect, test } from 'bun:test';
import { Pool } from 'pg';
import { v7 } from 'uuid';

const root = process.cwd();
const baseCompose = 'docker-compose.resilience.yml';
const sigtermCompose = 'docker-compose.resilience.sigterm.yml';
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

describe('SIGTERM consumer drain', () => {
  afterAll(async () => {
    sqs.destroy();
    await pool.end();
  });

  test('drains or redelivers messages without losing financial effects', async () => {
    await sqs.send(new PurgeQueueCommand({ QueueUrl: queueUrl }));
    const walletId = v7();
    const playerId = v7();
    const messages = Array.from({ length: 3 }, () => `sigterm-${randomUUID()}`);
    await pool.query(
      `insert into wallets (id, player_id, currency, balance_amount, version)
       values ($1, $2, 'BRL', 100.00, 1)`,
      [walletId, playerId],
    );

    await Promise.all(messages.map(async (messageId) => {
      await sqs.send(new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify({
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
            gameId: 'resilience-sigterm',
            kind: 'BET',
            money: { amount: '10.00', currency: 'BRL' },
          },
        }),
        MessageGroupId: `sigterm-group-${messageId}`,
        MessageDeduplicationId: messageId,
      }));
    }));

    const stopped = runDocker(['compose', '-f', baseCompose, 'stop', '-t', '10', 'resilience-app-1']);
    if (stopped.status !== 0) throw new Error(`SIGTERM stop failed: ${stopped.stderr}`);

    try {
      const deadline = Date.now() + 25_000;
      let snapshot: Record<string, string> | undefined;
      while (Date.now() < deadline) {
        const read = await pool.query(
          `select
             (select balance_amount::text from wallets where id = $1) as balance,
             (select count(*)::text from wager_transactions where wallet_id = $1) as transactions,
             (select count(*)::text from wallet_ledger_entries where wallet_id = $1) as ledger,
             (select count(*)::text from inbox_messages
               where consumer_name = $2 and message_id = any($3::text[]) and status = 'PROCESSED') as processed`,
          [walletId, consumerName, messages],
        );
        snapshot = read.rows[0];
        if (snapshot?.processed === '3') break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }

      expect(snapshot?.balance).toBe('70.00');
      expect(snapshot?.transactions).toBe('3');
      expect(snapshot?.ledger).toBe('3');
      expect(snapshot?.processed).toBe('3');
    } finally {
      const restarted = runDocker(['compose', '-f', baseCompose, 'up', '-d']);
      if (restarted.status !== 0) throw new Error(`Could not restore base composition: ${restarted.stderr}`);
    }
  }, 40_000);
});

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

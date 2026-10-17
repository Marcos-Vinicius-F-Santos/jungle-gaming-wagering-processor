import {
  GetQueueAttributesCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { Pool as PgPool } from 'pg';
import { v7 as uuidv7 } from 'uuid';
import { LoadDataCatalog, type LoadMessageSeed, type LoadOperationSeed, type LoadWalletSeed } from '../load-fixtures';
import { waitForDrain, validateLoadInvariants, type DrainSnapshot } from '../load-invariants';
import type { LoadConfig } from '../load-config';
import { LoadMetricsCollector } from '../load-metrics';
import type { LoadScenarioDriver } from '../load-executor';
import { seedOpeningLedger } from '../seed-opening-ledger';

const DEFAULT_QUEUE_URL = 'http://127.0.0.1:14566/000000000000/wager-transactions.fifo';
const DEFAULT_DLQ_URL = 'http://127.0.0.1:14566/000000000000/wager-transactions-dlq.fifo';
const DEFAULT_DATABASE_URL = 'postgresql://wagering:wagering@127.0.0.1:15432/wagering';
const CONSUMER_NAME = 'wager-transaction-consumer-v1';

interface PgClientLike {
  query<T = Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<{ rows: T[] }>;
  release(): void;
}

interface PgPoolLike {
  connect(): Promise<PgClientLike>;
  query<T = Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<{ rows: T[] }>;
  end(): Promise<void>;
}

export interface DistributedThroughputDependencies {
  sqs?: SQSClient;
  pool?: PgPoolLike;
  queueUrl?: string;
  dlqUrl?: string;
  databaseUrl?: string;
}

export class DistributedThroughputScenario implements LoadScenarioDriver {
  readonly metrics = new LoadMetricsCollector();
  readonly catalog: LoadDataCatalog;
  private readonly sqs: SQSClient;
  private readonly pool: PgPoolLike;
  private readonly queueUrl: string;
  private readonly dlqUrl: string;
  private readonly wallets: LoadWalletSeed[] = [];
  private readonly messages: LoadMessageSeed[] = [];
  private readonly inFlight = new Set<Promise<void>>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private generating = false;
  private currentPhase: 'warmup' | 'measurement' = 'warmup';
  private lastInvariantResult = validateLoadInvariants({
    wallets: [],
    inboxConflicts: 0,
    outboxFinancialDuplicates: 0,
    unexpectedDeadLetters: 0,
    queueDrained: false,
  });

  constructor(private readonly config: LoadConfig, dependencies: DistributedThroughputDependencies = {}) {
    this.catalog = new LoadDataCatalog(config.runId, 'distributed-throughput');
    this.sqs = dependencies.sqs ?? new SQSClient({
      region: process.env.AWS_REGION ?? 'us-east-1',
      endpoint: process.env.LOAD_SQS_ENDPOINT ?? process.env.RESILIENCE_SQS_ENDPOINT ?? 'http://127.0.0.1:14566',
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    });
    this.pool = dependencies.pool ?? new PgPool({
      connectionString: dependencies.databaseUrl ?? process.env.LOAD_DATABASE_URL ?? process.env.RESILIENCE_DATABASE_URL ?? DEFAULT_DATABASE_URL,
    });
    this.queueUrl = dependencies.queueUrl ?? process.env.LOAD_QUEUE_URL ?? process.env.RESILIENCE_QUEUE_URL ?? DEFAULT_QUEUE_URL;
    this.dlqUrl = dependencies.dlqUrl ?? process.env.LOAD_DLQ_URL ?? process.env.RESILIENCE_DLQ_URL ?? DEFAULT_DLQ_URL;
  }

  async prepare(): Promise<void> {
    for (let index = 0; index < 3; index += 1) {
      const wallet = this.catalog.wallet('1000000.00');
      const client = await this.pool.connect();
      try {
        const openingId = uuidv7();
        const ledgerId = uuidv7();
        await client.query('begin');
        await client.query(
          `insert into wallets (id, player_id, currency, balance_amount, version)
           values ($1, $2, $3, $4, 1)`,
          [wallet.walletId, wallet.playerId, wallet.currency, wallet.initialBalance],
        );
        await client.query(
          `insert into wager_transactions
             (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
              wallet_id, player_id, round_id, game_id, kind, amount, currency, status,
              processed_at, result_balance_amount, result_balance_currency)
           values ($1, $2, $3, null, null, $4, $5, null, $6, 'OPENING', $7, $8, 'PROCESSED', now(), $7, $8)`,
          [openingId, this.catalog.providerId(), `opening-${wallet.walletId}`, wallet.walletId, wallet.playerId, `load-${this.catalog.runId}`, wallet.initialBalance, wallet.currency],
        );
        await client.query(
          `insert into wallet_ledger_entries
             (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after)
           values ($1, $2, $3, 'CREDIT', $4, $5, 0, $4)`,
          [ledgerId, wallet.walletId, openingId, wallet.initialBalance, wallet.currency],
        );
        await seedOpeningLedger(client, {
          transactionId: openingId,
          walletId: wallet.walletId,
          currency: wallet.currency,
          amount: wallet.initialBalance,
        });
        await client.query('commit');
      } finally {
        await client.query('rollback').catch(() => undefined);
        client.release();
      }
      this.wallets.push(wallet);
    }
  }

  async startGenerating(phase: 'warmup' | 'measurement'): Promise<void> {
    if (this.generating) return;
    this.currentPhase = phase;
    this.generating = true;
    const rate = this.config.ratePerSecond ?? Math.max(1, this.config.concurrency);
    const intervalMs = Math.max(1, Math.floor(1_000 / rate));
    this.timer = setInterval(() => {
      const work = this.sendOne();
      this.inFlight.add(work);
      void work.finally(() => this.inFlight.delete(work));
    }, intervalMs);
    await this.sendOne();
  }

  async stopGenerating(): Promise<void> {
    if (!this.generating) return;
    this.generating = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await Promise.allSettled([...this.inFlight]);
  }

  async drain(timeoutMs: number): Promise<number> {
    const startedAt = Date.now();
    await waitForDrain(() => this.readDrainSnapshot(), timeoutMs);
    return Date.now() - startedAt;
  }

  async validate(): Promise<void> {
    const client = await this.pool.connect();
    try {
      const walletIds = this.wallets.map((wallet) => wallet.walletId);
      const result = await client.query<{
        id: string;
        balance: string;
        ledger_balance: string;
        transaction_count: string;
        ledger_count: string;
      }>(
        `select
           w.id,
           w.balance_amount::text as balance,
           coalesce(sum(case when l.direction = 'CREDIT' then l.amount else -l.amount end), 0)::text as ledger_balance,
           (select count(*) from wager_transactions t where t.wallet_id = w.id)::text as transaction_count,
           count(l.id)::text as ledger_count
         from wallets w
         left join wallet_ledger_entries l on l.wallet_id = w.id
         where w.id = any($1::uuid[])
         group by w.id, w.balance_amount`,
        [walletIds],
      );
      const snapshots = result.rows.map((row) => ({
        walletId: row.id,
        balance: row.balance,
        reconstructedBalance: row.ledger_balance,
        financialEffectDuplicates: Number(row.ledger_count) > Number(row.transaction_count) ? Number(row.ledger_count) - Number(row.transaction_count) : 0,
      }));
      const drain = await this.readDrainSnapshot();
      this.lastInvariantResult = validateLoadInvariants({
        wallets: snapshots,
        inboxConflicts: 0,
        outboxFinancialDuplicates: 0,
        unexpectedDeadLetters: drain.deadLetterMessages,
        queueDrained: drain.pendingMessages === 0 && drain.pendingOutbox === 0,
      });
      if (!this.lastInvariantResult.passed) throw new Error(this.lastInvariantResult.details.join('; '));
    } finally {
      client.release();
    }
  }

  getInvariantReport() {
    return this.lastInvariantResult;
  }

  getWalletIds(): readonly string[] {
    return this.wallets.map((wallet) => wallet.walletId);
  }

  async close(): Promise<void> {
    await this.stopGenerating();
    this.sqs.destroy();
    await this.pool.end();
  }

  private async sendOne(): Promise<void> {
    const wallet = this.wallets[this.messages.length % this.wallets.length];
    if (!wallet) throw new Error('distributed throughput scenario has no prepared wallet');
    const operation = this.catalog.operation(wallet, 'BET', '1.00');
    const message = this.catalog.message(operation);
    const startedAt = performance.now();
    try {
      await this.sqs.send(new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: JSON.stringify(buildDistributedMessage(message)),
        MessageGroupId: this.catalog.runId,
        MessageDeduplicationId: message.messageId,
      }));
      this.messages.push(message);
      if (this.currentPhase === 'measurement') {
        this.metrics.increment('operations_sent');
        this.metrics.observe('sqs_send_latency_ms', performance.now() - startedAt);
      }
    } catch (error) {
      if (this.currentPhase === 'measurement') this.metrics.increment('operations_failed');
      throw error;
    }
  }

  private async readDrainSnapshot(): Promise<DrainSnapshot> {
    const [queue, dlq, inbox, outbox] = await Promise.all([
      this.sqs.send(new GetQueueAttributesCommand({
        QueueUrl: this.queueUrl,
        AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
      })),
      this.sqs.send(new GetQueueAttributesCommand({
        QueueUrl: this.dlqUrl,
        AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
      })),
      this.pool.query(
        `select count(*)::text as count
         from inbox_messages
         where consumer_name = $1
           and message_id = any($2::text[])
           and status not in ('PROCESSED', 'FAILED_PERMANENT')`,
        [CONSUMER_NAME, this.messages.map((message) => message.messageId)],
      ),
      this.pool.query(
        `select count(*)::text as count
         from outbox_messages
         where aggregate_id in (select id from wager_transactions where wallet_id = any($1::uuid[]))
           and published_at is null
           and intervention_required = false`,
        [this.wallets.map((wallet) => wallet.walletId)],
      ),
    ]);
    const visible = Number(queue.Attributes?.ApproximateNumberOfMessages ?? 0);
    const inFlight = Number(queue.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0);
    return {
      pendingMessages: visible + inFlight + Number(inbox.rows[0]?.count ?? 0),
      pendingOutbox: Number(outbox.rows[0]?.count ?? 0),
      deadLetterMessages: Number(dlq.Attributes?.ApproximateNumberOfMessages ?? 0) + Number(dlq.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0),
    };
  }
}

export function buildDistributedMessage(message: LoadMessageSeed): Record<string, unknown> {
  const operation: LoadOperationSeed = message.operation;
  return {
    type: 'WagerTransactionRequested',
    messageId: message.messageId,
    occurredAt: new Date().toISOString(),
    correlationId: message.correlationId,
    data: operation,
  };
}

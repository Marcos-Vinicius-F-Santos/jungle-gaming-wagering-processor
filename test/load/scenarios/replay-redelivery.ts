import { GetQueueAttributesCommand, SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { Pool as PgPool } from 'pg';
import { v7 as uuidv7 } from 'uuid';
import { LoadDataCatalog, type LoadMessageSeed, type LoadWalletSeed } from '../load-fixtures';
import { waitForDrain, validateLoadInvariants, type DrainSnapshot } from '../load-invariants';
import type { LoadConfig } from '../load-config';
import { LoadMetricsCollector } from '../load-metrics';
import type { LoadScenarioDriver } from '../load-executor';
import { seedOpeningLedger } from '../seed-opening-ledger';

const QUEUE_URL = 'http://127.0.0.1:14566/000000000000/wager-transactions.fifo';
const DLQ_URL = 'http://127.0.0.1:14566/000000000000/wager-transactions-dlq.fifo';
const DATABASE_URL = 'postgresql://wagering:wagering@127.0.0.1:15432/wagering';
const CONSUMER_NAME = 'wager-transaction-consumer-v1';

interface PgClientLike { query<T = Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<{ rows: T[] }>; release(): void; }
interface PgPoolLike { connect(): Promise<PgClientLike>; query<T = Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<{ rows: T[] }>; end(): Promise<void>; }

export interface ReplayRedeliveryDependencies { sqs?: SQSClient; pool?: PgPoolLike; queueUrl?: string; dlqUrl?: string; databaseUrl?: string; }

export class ReplayRedeliveryScenario implements LoadScenarioDriver {
  readonly metrics = new LoadMetricsCollector();
  readonly catalog: LoadDataCatalog;
  private readonly sqs: SQSClient;
  private readonly pool: PgPoolLike;
  private readonly queueUrl: string;
  private readonly dlqUrl: string;
  private readonly inFlight = new Set<Promise<void>>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private wallet?: LoadWalletSeed;
  private baseMessage?: LoadMessageSeed;
  private sequence = 0;
  private generating = false;
  private phase: 'warmup' | 'measurement' = 'warmup';
  private invariantReport = validateLoadInvariants({ wallets: [], inboxConflicts: 0, outboxFinancialDuplicates: 0, unexpectedDeadLetters: 0, queueDrained: false });

  constructor(private readonly config: LoadConfig, dependencies: ReplayRedeliveryDependencies = {}) {
    this.catalog = new LoadDataCatalog(config.runId, 'replay-redelivery');
    this.sqs = dependencies.sqs ?? new SQSClient({ region: 'us-east-1', endpoint: process.env.LOAD_SQS_ENDPOINT ?? 'http://127.0.0.1:14566', credentials: { accessKeyId: 'test', secretAccessKey: 'test' } });
    this.pool = dependencies.pool ?? new PgPool({ connectionString: dependencies.databaseUrl ?? process.env.LOAD_DATABASE_URL ?? DATABASE_URL });
    this.queueUrl = dependencies.queueUrl ?? process.env.LOAD_QUEUE_URL ?? QUEUE_URL;
    this.dlqUrl = dependencies.dlqUrl ?? process.env.LOAD_DLQ_URL ?? DLQ_URL;
  }

  async prepare(): Promise<void> {
    this.wallet = this.catalog.wallet('1000000.00');
    const openingId = uuidv7();
    const ledgerId = uuidv7();
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query(`insert into wallets (id, player_id, currency, balance_amount, version) values ($1, $2, $3, $4, 1)`, [this.wallet.walletId, this.wallet.playerId, this.wallet.currency, this.wallet.initialBalance]);
      await client.query(
        `insert into wager_transactions (id, provider_id, external_transaction_id, wallet_id, player_id, game_id, kind, amount, currency, status, processed_at, result_balance_amount, result_balance_currency)
         values ($1, $2, $3, $4, $5, $6, 'OPENING', $7, $8, 'PROCESSED', now(), $7, $8)`,
        [openingId, this.catalog.providerId(), `opening-${this.wallet.walletId}`, this.wallet.walletId, this.wallet.playerId, `load-${this.catalog.runId}`, this.wallet.initialBalance, this.wallet.currency],
      );
      await client.query(`insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after) values ($1, $2, $3, 'CREDIT', $4, $5, 0, $4)`, [ledgerId, this.wallet.walletId, openingId, this.wallet.initialBalance, this.wallet.currency]);
      await seedOpeningLedger(client, {
        transactionId: openingId,
        walletId: this.wallet.walletId,
        currency: this.wallet.currency,
        amount: this.wallet.initialBalance,
      });
      await client.query('commit');
    } finally {
      await client.query('rollback').catch(() => undefined);
      client.release();
    }
    this.baseMessage = this.catalog.message(this.catalog.operation(this.wallet));
  }

  async startGenerating(phase: 'warmup' | 'measurement'): Promise<void> {
    if (this.generating) return;
    if (!this.baseMessage) throw new Error('replay scenario was not prepared');
    this.phase = phase;
    this.generating = true;
    const rate = this.config.ratePerSecond ?? Math.max(4, this.config.concurrency * 2);
    this.timer = setInterval(() => {
      const work = this.sendReplay();
      this.inFlight.add(work);
      void work.finally(() => this.inFlight.delete(work));
    }, Math.max(1, Math.floor(1_000 / rate)));
    await this.sendReplay();
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
    if (!this.wallet || !this.baseMessage) throw new Error('replay scenario was not prepared');
    const result = await this.pool.query<{ id: string; balance: string; ledger_balance: string; transaction_count: string; ledger_count: string; }>(
      `select w.id, w.balance_amount::text as balance,
          coalesce(sum(case when l.direction = 'CREDIT' then l.amount else -l.amount end), 0)::text as ledger_balance,
          (select count(*) from wager_transactions t where t.wallet_id = w.id)::text as transaction_count,
          count(l.id)::text as ledger_count
       from wallets w left join wallet_ledger_entries l on l.wallet_id = w.id
       where w.id = $1 group by w.id, w.balance_amount`, [this.wallet.walletId],
    );
    const row = result.rows[0];
    const drain = await this.readDrainSnapshot();
    this.invariantReport = validateLoadInvariants({
      wallets: row ? [{ walletId: row.id, balance: row.balance, reconstructedBalance: row.ledger_balance, financialEffectDuplicates: Math.max(0, Number(row.ledger_count) - Number(row.transaction_count)) }] : [],
      inboxConflicts: 0,
      outboxFinancialDuplicates: 0,
      unexpectedDeadLetters: drain.deadLetterMessages,
      queueDrained: drain.pendingMessages === 0 && drain.pendingOutbox === 0,
    });
    if (!this.invariantReport.passed) throw new Error(this.invariantReport.details.join('; '));
  }

  getInvariantReport() { return this.invariantReport; }

  async close(): Promise<void> { await this.stopGenerating(); this.sqs.destroy(); await this.pool.end(); }

  private async sendReplay(): Promise<void> {
    if (!this.baseMessage) throw new Error('replay scenario was not prepared');
    const sequence = ++this.sequence;
    const startedAt = performance.now();
    try {
      await this.sqs.send(new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: JSON.stringify(buildReplayMessage(this.baseMessage)),
        MessageGroupId: `replay-${this.catalog.runId}-${sequence}`,
        MessageDeduplicationId: `dedup-${this.catalog.runId}-${sequence}`,
      }));
      if (this.phase === 'measurement') {
        this.metrics.increment('replays');
        this.metrics.observe('sqs_send_latency_ms', performance.now() - startedAt);
      }
    } catch (error) {
      if (this.phase === 'measurement') this.metrics.increment('operations_failed');
      throw error;
    }
  }

  private async readDrainSnapshot(): Promise<DrainSnapshot> {
    const messageId = this.baseMessage?.messageId;
    const walletId = this.wallet?.walletId;
    const [queue, dlq, inbox, outbox] = await Promise.all([
      this.sqs.send(new GetQueueAttributesCommand({ QueueUrl: this.queueUrl, AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'] })),
      this.sqs.send(new GetQueueAttributesCommand({ QueueUrl: this.dlqUrl, AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'] })),
      this.pool.query(`select count(*)::text as count from inbox_messages where consumer_name = $1 and message_id = $2 and status not in ('PROCESSED', 'FAILED_PERMANENT')`, [CONSUMER_NAME, messageId]),
      this.pool.query(`select count(*)::text as count from outbox_messages where aggregate_id in (select id from wager_transactions where wallet_id = $1) and published_at is null and intervention_required = false`, [walletId]),
    ]);
    return {
      pendingMessages: Number(queue.Attributes?.ApproximateNumberOfMessages ?? 0) + Number(queue.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0) + Number(inbox.rows[0]?.count ?? 0),
      pendingOutbox: Number(outbox.rows[0]?.count ?? 0),
      deadLetterMessages: Number(dlq.Attributes?.ApproximateNumberOfMessages ?? 0) + Number(dlq.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0),
    };
  }
}

export function buildReplayMessage(message: LoadMessageSeed): Record<string, unknown> {
  return { type: 'WagerTransactionRequested', messageId: message.messageId, occurredAt: new Date().toISOString(), correlationId: message.correlationId, data: message.operation };
}

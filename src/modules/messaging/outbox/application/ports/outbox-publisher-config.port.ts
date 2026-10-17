export interface OutboxPublisherConfig {
  enabled: boolean;
  region: string;
  endpoint?: string;
  queueUrl: string;
  dlqUrl: string;
  publisherName: string;
  pollIntervalMs: number;
  batchSize: number;
  claimTimeoutSeconds: number;
  retryBackoffSeconds: readonly number[];
}

export const OUTBOX_PUBLISHER_CONFIG = Symbol('OUTBOX_PUBLISHER_CONFIG');

export function readOutboxPublisherConfig(env: NodeJS.ProcessEnv = process.env): OutboxPublisherConfig {
  const endpoint = env.SQS_ENDPOINT || undefined;
  const region = env.AWS_REGION ?? 'us-east-1';
  const queueEndpoint = endpoint ?? `https://sqs.${region}.amazonaws.com`;

  return {
    enabled: env.OUTBOX_ENABLED === 'true',
    region,
    endpoint,
    queueUrl: env.OUTBOX_EVENTS_QUEUE_URL
      ?? `${queueEndpoint}/000000000000/wager-events.fifo`,
    dlqUrl: env.OUTBOX_EVENTS_DLQ_URL
      ?? `${queueEndpoint}/000000000000/wager-events-dlq.fifo`,
    publisherName: env.OUTBOX_PUBLISHER_NAME ?? 'wager-event-publisher-v1',
    pollIntervalMs: readInteger(env.OUTBOX_POLL_INTERVAL_MS, 1000, 50, 60_000),
    batchSize: readInteger(env.OUTBOX_BATCH_SIZE, 50, 1, 100),
    claimTimeoutSeconds: readInteger(env.OUTBOX_CLAIM_TIMEOUT_SECONDS, 60, 5, 3600),
    retryBackoffSeconds: readBackoff(env.OUTBOX_RETRY_BACKOFF_SECONDS),
  };
}

function readBackoff(value: string | undefined): readonly number[] {
  const parsed = (value ?? '30,60,120,240,300')
    .split(',')
    .map((item) => Number(item.trim()));
  if (parsed.length === 0 || parsed.some((item) => !Number.isInteger(item) || item < 1)) {
    throw new Error('OUTBOX_RETRY_BACKOFF_SECONDS must contain positive integers');
  }
  return parsed;
}

function readInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`Outbox integer configuration must be between ${min} and ${max}`);
  }
  return parsed;
}

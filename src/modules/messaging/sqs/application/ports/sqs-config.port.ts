export interface SqsConfig {
  enabled: boolean;
  region: string;
  endpoint?: string;
  queueUrl: string;
  dlqUrl: string;
  consumerName: string;
  waitTimeSeconds: number;
  maxNumberOfMessages: number;
  visibilityTimeoutSeconds: number;
  inboxLeaseSeconds: number;
  instanceId: string;
  retryBackoffSeconds: readonly number[];
}

export const SQS_CONFIG = Symbol('SQS_CONFIG');

export function readSqsConfig(env: NodeJS.ProcessEnv = process.env): SqsConfig {
  const endpoint = env.SQS_ENDPOINT || undefined;
  const defaultEndpoint = `https://sqs.${env.AWS_REGION ?? 'us-east-1'}.amazonaws.com`;
  const queueEndpoint = endpoint ?? defaultEndpoint;
  const queueUrl = env.SQS_QUEUE_URL
    ?? `${queueEndpoint}/000000000000/wager-transactions.fifo`;
  const dlqUrl = env.SQS_DLQ_URL
    ?? `${queueEndpoint}/000000000000/wager-transactions-dlq.fifo`;

  return {
    enabled: env.SQS_ENABLED === 'true',
    region: env.AWS_REGION ?? 'us-east-1',
    endpoint,
    queueUrl,
    dlqUrl,
    consumerName: env.SQS_CONSUMER_NAME ?? 'wager-transaction-consumer-v1',
    waitTimeSeconds: readInteger(env.SQS_WAIT_TIME_SECONDS, 10, 0, 20),
    maxNumberOfMessages: readInteger(env.SQS_MAX_NUMBER_OF_MESSAGES, 10, 1, 10),
    visibilityTimeoutSeconds: readInteger(env.SQS_VISIBILITY_TIMEOUT_SECONDS, 60, 1, 43200),
    inboxLeaseSeconds: readInteger(env.SQS_INBOX_LEASE_SECONDS, 120, 5, 43200),
    instanceId: env.SQS_INSTANCE_ID ?? process.env.HOSTNAME ?? `wager-consumer-${process.pid}`,
    retryBackoffSeconds: readBackoff(env.SQS_RETRY_BACKOFF_SECONDS),
  };
}

function readBackoff(value: string | undefined): readonly number[] {
  const parsed = (value ?? '30,60,120,240,300')
    .split(',')
    .map((item) => Number(item.trim()));
  if (parsed.length === 0 || parsed.some((item) => !Number.isInteger(item) || item < 1 || item > 43200)) {
    throw new Error('SQS_RETRY_BACKOFF_SECONDS must contain positive integers up to 43200');
  }
  return parsed;
}

function readInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`SQS integer configuration must be between ${min} and ${max}`);
  }
  return parsed;
}

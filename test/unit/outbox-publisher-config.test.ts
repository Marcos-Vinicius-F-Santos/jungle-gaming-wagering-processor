import { describe, expect, test } from 'bun:test';

import { readOutboxPublisherConfig } from '../../src/modules/messaging/outbox/application/ports/outbox-publisher-config.port';

describe('readOutboxPublisherConfig', () => {
  test('uses safe local defaults', () => {
    const config = readOutboxPublisherConfig({
      SQS_ENDPOINT: 'http://localhost:4566',
      AWS_REGION: 'us-east-1',
    });

    expect(config.enabled).toBe(false);
    expect(config.queueUrl).toContain('wager-events.fifo');
    expect(config.dlqUrl).toContain('wager-events-dlq.fifo');
    expect(config.retryBackoffSeconds).toEqual([30, 60, 120, 240, 300]);
  });

  test('rejects invalid operational bounds', () => {
    expect(() => readOutboxPublisherConfig({ OUTBOX_BATCH_SIZE: '0' })).toThrow();
    expect(() => readOutboxPublisherConfig({ OUTBOX_RETRY_BACKOFF_SECONDS: '30,nope' })).toThrow();
  });
});

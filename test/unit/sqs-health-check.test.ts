import { describe, expect, test } from 'bun:test';

import { AwsSqsHealthCheck } from '../../src/interfaces/health/infrastructure/sqs.health-check';

const sqsConfig = {
  enabled: true,
  region: 'us-east-1',
  endpoint: 'http://localhost:4566',
  queueUrl: 'http://localhost:4566/input.fifo',
  dlqUrl: 'http://localhost:4566/input-dlq.fifo',
  consumerName: 'consumer',
  waitTimeSeconds: 0,
  maxNumberOfMessages: 10,
  visibilityTimeoutSeconds: 60,
  inboxLeaseSeconds: 120,
  instanceId: 'test-instance',
  retryBackoffSeconds: [30, 60, 120, 240, 300],
};

const outboxConfig = {
  enabled: true,
  region: 'us-east-1',
  endpoint: 'http://localhost:4566',
  queueUrl: 'http://localhost:4566/events.fifo',
  dlqUrl: 'http://localhost:4566/events-dlq.fifo',
  publisherName: 'publisher',
  pollIntervalMs: 1000,
  batchSize: 10,
  claimTimeoutSeconds: 60,
  retryBackoffSeconds: [30, 60, 120, 240, 300],
};

describe('AwsSqsHealthCheck', () => {
  test('checks only queue attributes for input and events queues', async () => {
    const commands: string[] = [];
    const client = {
      send: async (command: { input: { QueueUrl: string; AttributeNames: string[] } }) => {
        commands.push(`${command.input.QueueUrl}:${command.input.AttributeNames.join(',')}`);
      },
      destroy: () => undefined,
    };
    const adapter = new AwsSqsHealthCheck(sqsConfig, outboxConfig, client as never);

    await expect(adapter.checkInputQueue()).resolves.toMatchObject({ component: 'sqsInput', status: 'up' });
    await expect(adapter.checkEventsQueue()).resolves.toMatchObject({ component: 'sqsEvents', status: 'up' });
    expect(commands).toEqual([
      'http://localhost:4566/input.fifo:QueueArn',
      'http://localhost:4566/events.fifo:QueueArn',
    ]);
  });

  test('reports disabled events queue without contacting SQS', async () => {
    let calls = 0;
    const client = {
      send: async () => { calls += 1; },
      destroy: () => undefined,
    };
    const adapter = new AwsSqsHealthCheck(sqsConfig, { ...outboxConfig, enabled: false }, client as never);

    await expect(adapter.checkEventsQueue()).resolves.toEqual({ component: 'sqsEvents', status: 'disabled' });
    expect(calls).toBe(0);
  });

  test('normalizes SQS failures without exposing queue details', async () => {
    const client = {
      send: async () => { throw new Error('secret queue URL'); },
      destroy: () => undefined,
    };
    const adapter = new AwsSqsHealthCheck(sqsConfig, outboxConfig, client as never);

    await expect(adapter.checkInputQueue()).resolves.toMatchObject({
      component: 'sqsInput',
      status: 'down',
      errorCode: 'SQS_QUEUE_UNAVAILABLE',
    });
  });
});

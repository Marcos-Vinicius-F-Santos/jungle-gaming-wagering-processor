import 'reflect-metadata';

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';

process.env.SQS_ENABLED = 'false';
process.env.OUTBOX_ENABLED = 'false';
process.env.SQS_ENDPOINT = process.env.SQS_ENDPOINT ?? 'http://localhost:4566';
process.env.SQS_QUEUE_URL = process.env.SQS_QUEUE_URL
  ?? 'http://localhost:4566/000000000000/wager-transactions.fifo';
process.env.SQS_DLQ_URL = process.env.SQS_DLQ_URL
  ?? 'http://localhost:4566/000000000000/wager-transactions-dlq.fifo';
process.env.OUTBOX_EVENTS_QUEUE_URL = process.env.OUTBOX_EVENTS_QUEUE_URL
  ?? 'http://localhost:4566/000000000000/wager-events.fifo';
process.env.OUTBOX_EVENTS_DLQ_URL = process.env.OUTBOX_EVENTS_DLQ_URL
  ?? 'http://localhost:4566/000000000000/wager-events-dlq.fifo';

import { AppModule } from '../../src/app.module';

describe('Health integration', () => {
  let app: INestApplication;
  let sqs: SQSClient;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.listen(0);
    sqs = new SQSClient({
      region: 'us-east-1',
      endpoint: 'http://localhost:4566',
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    });
  });

  afterAll(async () => {
    sqs.destroy();
    await app.close();
  });

  test('checks real PostgreSQL and LocalStack queues without consuming messages', async () => {
    const queueUrl = process.env.SQS_QUEUE_URL!;
    const before = await queueAttributes(queueUrl);
    const live = await fetch(`${await app.getUrl()}/health/live`);
    const ready = await fetch(`${await app.getUrl()}/health/ready`);
    const after = await queueAttributes(queueUrl);

    expect(live.status).toBe(200);
    expect(await live.json()).toEqual({ status: 'ok' });
    expect(ready.status).toBe(200);

    const report = await ready.json() as {
      ready: boolean;
      status: string;
      components: Record<string, { status: string }>;
    };
    expect(report).toMatchObject({
      ready: true,
      status: 'ok',
      components: {
        postgres: { status: 'up' },
        sqsInput: { status: 'up' },
        sqsEvents: { status: 'disabled' },
        outboxPublisher: { status: 'disabled' },
      },
    });
    expect(after).toEqual(before);
  });

  async function queueAttributes(queueUrl: string): Promise<Record<string, string>> {
    const response = await sqs.send(new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
    }));
    return response.Attributes ?? {};
  }
});

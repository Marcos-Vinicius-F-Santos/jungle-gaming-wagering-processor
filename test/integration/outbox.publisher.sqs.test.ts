import 'reflect-metadata';

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { INestApplicationContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { EntityManager } from '@mikro-orm/postgresql';
import { ReceiveMessageCommand, SQSClient, type Message } from '@aws-sdk/client-sqs';
import { v4, v7 } from 'uuid';

process.env.OUTBOX_ENABLED = 'false';
process.env.SQS_ENDPOINT = process.env.SQS_ENDPOINT ?? 'http://localhost:4566';
process.env.OUTBOX_BATCH_SIZE = '1';
process.env.OUTBOX_EVENTS_QUEUE_URL = process.env.OUTBOX_EVENTS_QUEUE_URL
  ?? 'http://localhost:4566/000000000000/wager-events.fifo';
process.env.OUTBOX_EVENTS_DLQ_URL = process.env.OUTBOX_EVENTS_DLQ_URL
  ?? 'http://localhost:4566/000000000000/wager-events-dlq.fifo';

import { AppModule } from '../../src/app.module';
import { OutboxPublisherWorker } from '../../src/modules/messaging/outbox/application/outbox-publisher.worker';
import { readOutboxPublisherConfig } from '../../src/modules/messaging/outbox/application/ports/outbox-publisher-config.port';
import { OUTBOX_REPOSITORY } from '../../src/modules/messaging/outbox/application/ports/outbox-repository.port';
import type { OutboxRepository } from '../../src/modules/messaging/outbox/application/ports/outbox-repository.port';
import { OutboxMessage } from '../../src/modules/messaging/outbox/domain/outbox-message';
import { SqsMessagePublisherAdapter } from '../../src/modules/messaging/outbox/infrastructure/sqs-message-publisher.adapter';
import { CLOCK } from '../../src/shared/application/ports/clock.port';
import type { Clock } from '../../src/shared/application/ports/clock.port';
import { LOGGER } from '../../src/shared/application/ports/logger.port';
import type { AppLogger } from '../../src/shared/application/ports/logger.port';
import { METRICS } from '../../src/shared/application/ports/metrics.port';
import type { Metrics } from '../../src/shared/application/ports/metrics.port';
import { UNIT_OF_WORK } from '../../src/shared/application/ports/unit-of-work.port';
import type { UnitOfWork } from '../../src/shared/application/ports/unit-of-work.port';
import { CORRELATION_CONTEXT } from '../../src/shared/application/ports/correlation-context.port';
import type { CorrelationContext } from '../../src/shared/application/ports/correlation-context.port';

async function receiveMessageByEventId(
  sqs: SQSClient,
  queueUrl: string,
  eventId: string,
  timeoutMs = 5_000,
): Promise<Message> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const response = await sqs.send(new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: 1,
      MessageAttributeNames: ['All'],
    }));
    const received = (response.Messages ?? []).find(
      (message) => message.MessageAttributes?.eventId?.StringValue === eventId,
    );

    if (received) return received;
  }

  throw new Error(`Timed out waiting for SQS message ${eventId} on ${queueUrl}`);
}

describe('Transactional Outbox SQS publisher', () => {
  let app: INestApplicationContext;
  let entityManager: EntityManager;
  let repository: OutboxRepository;
  let unitOfWork: UnitOfWork;
  let sqs: SQSClient;

  beforeAll(async () => {
    app = await Test.createTestingModule({ imports: [AppModule] }).compile();
    entityManager = app.get(EntityManager);
    repository = app.get(OUTBOX_REPOSITORY);
    unitOfWork = app.get(UNIT_OF_WORK);
    sqs = new SQSClient({
      region: 'us-east-1',
      endpoint: 'http://localhost:4566',
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    });
    await entityManager.getConnection().execute(
      `update outbox_messages
       set intervention_required = true,
           last_error_code = 'INTEGRATION_TEST_RESET',
           last_error_at = now()
       where published_at is null and intervention_required = false`,
    );
  });

  afterAll(async () => {
    sqs.destroy();
    await app.close();
  });

  test('publishes the committed envelope with FIFO metadata', async () => {
    const event = OutboxMessage.enqueue({
      eventId: v7(),
      aggregateId: v4(),
      correlationId: `integration-${v4()}`,
      eventType: 'WalletBalanceChanged',
      version: 1,
      data: { walletId: v4(), amount: '10.00', currency: 'BRL' },
      occurredAt: new Date(),
    });
    await unitOfWork.execute(() => repository.enqueue(event));

    const worker = app.get(OutboxPublisherWorker);
    expect(await worker.publishNextBatch()).toBeGreaterThanOrEqual(1);

    const received = await receiveMessageByEventId(
      sqs,
      process.env.OUTBOX_EVENTS_QUEUE_URL!,
      event.eventId,
    );
    expect(JSON.parse(received.Body!)).toEqual(event.toJSON());

    const rows = await entityManager.getConnection().execute<{ published_at: Date | null }[]>(
      'select published_at from outbox_messages where event_id = ?',
      [event.eventId],
    );
    expect(rows[0].published_at).not.toBeNull();
  });

  test('sends the fifth failed publish to the DLQ and preserves the original row (regression)', async () => {
    const event = OutboxMessage.enqueue({
      eventId: v7(),
      aggregateId: v4(),
      correlationId: `integration-${v4()}`,
      eventType: 'WagerTransactionRejected',
      version: 1,
      data: { transactionId: v4(), failureCode: 'BROKER_TIMEOUT' },
      occurredAt: new Date(),
    });
    await unitOfWork.execute(() => repository.enqueue(event));
    await entityManager.getConnection().execute(
      'update outbox_messages set attempts = 4 where event_id = ?',
      [event.eventId],
    );

    const config = readOutboxPublisherConfig(process.env);
    const adapter = new SqsMessagePublisherAdapter(config);
    const publisher = {
      publish: async () => { throw new Error('BROKER_TIMEOUT'); },
      publishToDeadLetter: (message: OutboxMessage) => adapter.publishToDeadLetter(message),
    };
    const worker = new OutboxPublisherWorker(
      repository,
      publisher,
      config,
      unitOfWork,
      app.get<Clock>(CLOCK),
      app.get<CorrelationContext>(CORRELATION_CONTEXT),
      app.get<AppLogger>(LOGGER),
      app.get<Metrics>(METRICS),
    );

    await worker.publishNextBatch();
    adapter.onModuleDestroy();

    const received = await receiveMessageByEventId(
      sqs,
      process.env.OUTBOX_EVENTS_DLQ_URL!,
      event.eventId,
    );
    expect(JSON.parse(received.Body!)).toEqual(event.toJSON());

    const rows = await entityManager.getConnection().execute<{
      attempts: number;
      published_at: Date | null;
      intervention_required: boolean;
      dead_lettered_at: Date | null;
    }[]>('select attempts, published_at, intervention_required, dead_lettered_at from outbox_messages where event_id = ?', [event.eventId]);
    expect(rows[0]).toMatchObject({ attempts: 5, published_at: null, intervention_required: true });
    expect(rows[0].dead_lettered_at).not.toBeNull();
  });
});

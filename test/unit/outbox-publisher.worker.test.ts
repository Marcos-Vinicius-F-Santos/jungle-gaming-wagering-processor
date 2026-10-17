import { describe, expect, test } from 'bun:test';
import { v7 as uuidv7 } from 'uuid';

import type { Clock } from '../../src/shared/application/ports/clock.port';
import type { AppLogger } from '../../src/shared/application/ports/logger.port';
import type { Metrics } from '../../src/shared/application/ports/metrics.port';
import { AsyncLocalCorrelationContext } from '../../src/shared/infrastructure/correlation/async-local-correlation-context';
import type { UnitOfWork } from '../../src/shared/application/ports/unit-of-work.port';
import { OutboxPublisherWorker } from '../../src/modules/messaging/outbox/application/outbox-publisher.worker';
import type { MessagePublisher } from '../../src/modules/messaging/outbox/application/ports/message-publisher.port';
import type { OutboxPublisherConfig } from '../../src/modules/messaging/outbox/application/ports/outbox-publisher-config.port';
import type { OutboxRepository } from '../../src/modules/messaging/outbox/application/ports/outbox-repository.port';
import { OutboxMessage } from '../../src/modules/messaging/outbox/domain/outbox-message';

const now = new Date('2026-10-15T20:00:00.000Z');

function message(attempts = 0): OutboxMessage {
  return OutboxMessage.rehydrate({
    eventId: uuidv7(),
    aggregateId: uuidv7(),
    correlationId: 'correlation-a',
    eventType: 'WagerTransactionProcessed',
    version: 1,
    data: { transactionId: uuidv7() },
    occurredAt: now,
    attempts,
    nextAttemptAt: now,
  });
}

function config(): OutboxPublisherConfig {
  return {
    enabled: false,
    region: 'us-east-1',
    endpoint: 'http://localhost:4566',
    queueUrl: 'http://localhost:4566/events.fifo',
    dlqUrl: 'http://localhost:4566/events-dlq.fifo',
    publisherName: 'publisher-test',
    pollIntervalMs: 1000,
    batchSize: 50,
    claimTimeoutSeconds: 60,
    retryBackoffSeconds: [30, 60, 120, 240, 300],
  };
}

function createWorker(
  messages: OutboxMessage[],
  publisher: MessagePublisher,
  overrides: Partial<OutboxRepository> = {},
  configOverrides: Partial<OutboxPublisherConfig> = {},
): OutboxPublisherWorker {
  const repository: OutboxRepository = {
    enqueue: async () => undefined,
    claimDue: async () => messages,
    markPublished: async () => true,
    scheduleRetry: async () => true,
    markIntervention: async () => true,
    getLag: async () => ({ pendingCount: messages.length }),
    ...overrides,
  };
  const unitOfWork: UnitOfWork = { execute: async (work) => work() };
  const clock: Clock = { now: () => new Date(now) };
  const logger: AppLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };
  const metrics: Metrics = { increment: () => undefined };
  return new OutboxPublisherWorker(repository, publisher, { ...config(), ...configOverrides }, unitOfWork, clock, new AsyncLocalCorrelationContext(), logger, metrics);
}

describe('OutboxPublisherWorker', () => {
  test('publishes and confirms every claimed message', async () => {
    const published: string[] = [];
    const worker = createWorker([message()], {
      publish: async (event) => { published.push(event.eventId); },
      publishToDeadLetter: async () => undefined,
    });

    expect(await worker.publishNextBatch()).toBe(1);
    expect(published).toHaveLength(1);
  });

  test('sends a message at the retry limit to the dead letter publisher', async () => {
    const deadLettered: string[] = [];
    const worker = createWorker([message(5)], {
      publish: async () => { throw new Error('main queue should not be used'); },
      publishToDeadLetter: async (event) => { deadLettered.push(event.eventId); },
    });

    expect(await worker.publishNextBatch()).toBe(1);
    expect(deadLettered).toHaveLength(1);
  });

  test('schedules a transient publish failure with the approved backoff', async () => {
    let retry: { eventId: string; nextAttemptAt: Date; errorCode: string } | undefined;
    const event = message();
    const worker = createWorker([event], {
      publish: async () => { throw new Error('BROKER_TIMEOUT'); },
      publishToDeadLetter: async () => undefined,
    }, {
      scheduleRetry: async (eventId, _publisherName, _now, nextAttemptAt, errorCode) => {
        retry = { eventId, nextAttemptAt, errorCode };
        return true;
      },
    });

    await worker.publishNextBatch();
    expect(retry?.eventId).toBe(event.eventId);
    expect(retry?.errorCode).toBe('BROKER_TIMEOUT');
    expect(retry?.nextAttemptAt).toEqual(new Date(now.getTime() + 30_000));
  });

  test('exposes disabled, healthy and degraded operational states', async () => {
    const disabled = createWorker([], { publish: async () => undefined, publishToDeadLetter: async () => undefined });
    expect(disabled.getStatus()).toEqual({ component: 'outboxPublisher', status: 'disabled' });

    const healthy = createWorker([], { publish: async () => undefined, publishToDeadLetter: async () => undefined }, {}, { enabled: true });
    await healthy.publishNextBatch();
    expect(healthy.getStatus()).toMatchObject({ component: 'outboxPublisher', status: 'up', pendingCount: 0 });

    const degraded = createWorker([message()], {
      publish: async () => { throw new Error('BROKER_TIMEOUT'); },
      publishToDeadLetter: async () => undefined,
    }, {}, { enabled: true });
    await degraded.publishNextBatch();
    expect(degraded.getStatus()).toMatchObject({
      component: 'outboxPublisher',
      status: 'degraded',
      errorCode: 'BROKER_TIMEOUT',
    });
  });

  test('keeps the event recoverable when confirmation fails after broker publish', async () => {
    let published = 0;
    let retryScheduled = 0;
    const worker = createWorker([message()], {
      publish: async () => { published += 1; },
      publishToDeadLetter: async () => undefined,
    }, {
      markPublished: async () => { throw new Error('DATABASE_CONFIRMATION_FAILED'); },
      scheduleRetry: async () => { retryScheduled += 1; return true; },
    });

    await worker.publishNextBatch();
    expect(published).toBe(1);
    expect(retryScheduled).toBe(1);
  });

  test('stops polling and drains when destroyed', async () => {
    let claims = 0;
    const worker = createWorker([], {
      publish: async () => undefined,
      publishToDeadLetter: async () => undefined,
    }, {
      claimDue: async () => {
        claims += 1;
        return [];
      },
    }, { enabled: true, pollIntervalMs: 1 });

    worker.onModuleInit();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await worker.onModuleDestroy();
    const claimsAfterDestroy = claims;
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(claims).toBe(claimsAfterDestroy);
  });
});

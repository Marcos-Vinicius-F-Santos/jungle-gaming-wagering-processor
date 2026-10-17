import { describe, expect, test } from 'bun:test';

import type {
  HealthComponent,
  OutboxPublisherHealth,
  PostgresHealthCheck,
  SqsHealthCheck,
} from '../../src/interfaces/health/application/ports/health.port';

describe('Health ports', () => {
  test('represent safe dependency outcomes without infrastructure types', async () => {
    const component: HealthComponent = {
      component: 'postgres',
      status: 'timeout',
      latencyMs: 500,
      errorCode: 'HEALTH_CHECK_TIMEOUT',
    };
    const postgres: PostgresHealthCheck = {
      check: async () => component,
    };
    const sqs: SqsHealthCheck = {
      checkInputQueue: async () => ({ component: 'sqsInput', status: 'up', latencyMs: 4 }),
      checkEventsQueue: async () => ({ component: 'sqsEvents', status: 'degraded' }),
    };
    const outbox: OutboxPublisherHealth = {
      getStatus: () => ({ component: 'outboxPublisher', status: 'disabled' }),
    };

    await expect(postgres.check()).resolves.toEqual(component);
    await expect(sqs.checkInputQueue()).resolves.toMatchObject({ status: 'up' });
    await expect(sqs.checkEventsQueue()).resolves.toMatchObject({ status: 'degraded' });
    expect(outbox.getStatus()).toEqual({ component: 'outboxPublisher', status: 'disabled' });
  });
});

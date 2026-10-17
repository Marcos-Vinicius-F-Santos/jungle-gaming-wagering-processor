import { describe, expect, test } from 'bun:test';

import { HealthService } from '../../src/interfaces/health/application/health.service';
import { InMemoryMetrics } from '../../src/shared/infrastructure/metrics/in-memory-metrics';

function dependencies(overrides: {
  postgres?: () => Promise<{ component: string; status: 'up' | 'down' | 'timeout' }>;
  input?: () => Promise<{ component: string; status: 'up' | 'down' | 'timeout' }>;
  events?: () => Promise<{ component: string; status: 'up' | 'degraded' | 'timeout' }>;
} = {}) {
  return {
    postgres: { check: overrides.postgres ?? (async () => ({ component: 'postgres', status: 'up' as const })) },
    sqs: {
      checkInputQueue: overrides.input ?? (async () => ({ component: 'sqsInput', status: 'up' as const })),
      checkEventsQueue: overrides.events ?? (async () => ({ component: 'sqsEvents', status: 'up' as const })),
    },
    outbox: { getStatus: () => ({ component: 'outboxPublisher', status: 'up' as const }) },
  };
}

describe('HealthService', () => {
  test('is ready when PostgreSQL and input SQS are up, even if events are degraded', async () => {
    const deps = dependencies({ events: async () => ({ component: 'sqsEvents', status: 'degraded' }) });
    const service = new HealthService(deps.postgres, deps.sqs, deps.outbox, { dependencyTimeoutMs: 500, totalTimeoutMs: 1_000 }, new InMemoryMetrics());

    const report = await service.readiness();

    expect(report).toMatchObject({ ready: true, status: 'ok' });
    expect(report.components.sqsEvents).toMatchObject({ status: 'degraded' });
  });

  test('is not ready when a required dependency is down', async () => {
    const deps = dependencies({ postgres: async () => ({ component: 'postgres', status: 'down' }) });
    const service = new HealthService(deps.postgres, deps.sqs, deps.outbox);

    const report = await service.readiness();

    expect(report).toMatchObject({ ready: false, status: 'not_ready' });
    expect(report.components.postgres).toMatchObject({ status: 'down' });
  });

  test('classifies a slow required dependency as timeout within the configured limit', async () => {
    const deps = dependencies({ postgres: () => delay(50).then(() => ({ component: 'postgres', status: 'up' as const })) });
    const startedAt = Date.now();
    const service = new HealthService(deps.postgres, deps.sqs, deps.outbox, { dependencyTimeoutMs: 10, totalTimeoutMs: 30 });

    const report = await service.readiness();

    expect(report.components.postgres).toMatchObject({ status: 'timeout', errorCode: 'HEALTH_CHECK_TIMEOUT' });
    expect(Date.now() - startedAt).toBeLessThan(100);
  });
});

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

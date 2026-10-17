import { describe, expect, test } from 'bun:test';

import { HealthController } from '../../src/interfaces/health/health.controller';

describe('HealthController', () => {
  test('returns local liveness without invoking dependencies', () => {
    const controller = new HealthController({
      readiness: async () => { throw new Error('should not be called'); },
    } as never);

    expect(controller.live()).toEqual({ status: 'ok' });
  });

  test('maps readiness to 200 and 503 while preserving the safe report', async () => {
    const report = {
      ready: false,
      status: 'not_ready' as const,
      checkedAt: '2026-10-16T00:00:00.000Z',
      components: { postgres: { component: 'postgres', status: 'down' as const, errorCode: 'POSTGRES_UNAVAILABLE' } },
    };
    const controller = new HealthController({ readiness: async () => report } as never);
    const response = { statusCode: 200 };

    await expect(controller.ready(response)).resolves.toEqual(report);
    expect(response.statusCode).toBe(503);
  });
});

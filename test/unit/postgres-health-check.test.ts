import { describe, expect, test } from 'bun:test';

import { MikroOrmPostgresHealthCheck } from '../../src/interfaces/health/infrastructure/mikro-orm-postgres.health-check';

describe('MikroOrmPostgresHealthCheck', () => {
  test('uses a read-only connectivity query and reports latency', async () => {
    const queries: string[] = [];
    const adapter = new MikroOrmPostgresHealthCheck({
      getConnection: () => ({
        execute: async (query: string) => {
          queries.push(query);
          return [{ '?column?': 1 }];
        },
      }),
    } as never);

    await expect(adapter.check()).resolves.toMatchObject({
      component: 'postgres',
      status: 'up',
    });
    expect(queries).toEqual(['select 1']);
  });

  test('normalizes connectivity failures without exposing database details', async () => {
    const adapter = new MikroOrmPostgresHealthCheck({
      getConnection: () => ({
        execute: async () => { throw new Error('secret host and SQL details'); },
      }),
    } as never);

    await expect(adapter.check()).resolves.toMatchObject({
      component: 'postgres',
      status: 'down',
      errorCode: 'POSTGRES_UNAVAILABLE',
    });
  });
});

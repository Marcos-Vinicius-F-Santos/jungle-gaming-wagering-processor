import { EntityManager } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';

import type { HealthComponent, PostgresHealthCheck } from '../application/ports/health.port';

@Injectable()
export class MikroOrmPostgresHealthCheck implements PostgresHealthCheck {
  constructor(private readonly entityManager: EntityManager) {}

  async check(): Promise<HealthComponent> {
    const startedAt = Date.now();
    try {
      await this.entityManager.getConnection().execute('select 1');
      return {
        component: 'postgres',
        status: 'up',
        latencyMs: Date.now() - startedAt,
      };
    } catch {
      return {
        component: 'postgres',
        status: 'down',
        latencyMs: Date.now() - startedAt,
        errorCode: 'POSTGRES_UNAVAILABLE',
      };
    }
  }
}

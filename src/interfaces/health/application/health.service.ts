import { Inject, Injectable, Optional } from '@nestjs/common';

import { METRICS } from '../../../shared/application/ports/metrics.port';
import type { Metrics } from '../../../shared/application/ports/metrics.port';
import {
  OUTBOX_PUBLISHER_HEALTH,
  POSTGRES_HEALTH_CHECK,
  SQS_HEALTH_CHECK,
} from './ports/health.port';
import type {
  HealthComponent,
  OutboxPublisherHealth,
  PostgresHealthCheck,
  SqsHealthCheck,
} from './ports/health.port';
import { DEFAULT_HEALTH_CONFIG, HEALTH_CONFIG } from './ports/health-config.port';
import type { HealthConfig } from './ports/health-config.port';

export interface ReadinessReport {
  readonly ready: boolean;
  readonly status: 'ok' | 'not_ready';
  readonly checkedAt: string;
  readonly components: Readonly<Record<string, HealthComponent>>;
}

@Injectable()
export class HealthService {
  constructor(
    @Inject(POSTGRES_HEALTH_CHECK) private readonly postgres: PostgresHealthCheck,
    @Inject(SQS_HEALTH_CHECK) private readonly sqs: SqsHealthCheck,
    @Inject(OUTBOX_PUBLISHER_HEALTH) private readonly outbox: OutboxPublisherHealth,
    @Inject(HEALTH_CONFIG) private readonly config: HealthConfig = DEFAULT_HEALTH_CONFIG,
    @Optional() @Inject(METRICS) private readonly metrics?: Metrics,
  ) {}

  async readiness(): Promise<ReadinessReport> {
    const checkedAt = new Date().toISOString();
    const checks = [
      this.runCheck('postgres', () => this.postgres.check()),
      this.runCheck('sqsInput', () => this.sqs.checkInputQueue()),
      this.runCheck('sqsEvents', () => this.sqs.checkEventsQueue()),
      Promise.resolve(this.safeOutboxStatus()),
    ];
    const components = await withTimeout(
      Promise.all(checks),
      this.config.totalTimeoutMs,
      () => checks.map((_check, index) => ({
        component: ['postgres', 'sqsInput', 'sqsEvents', 'outboxPublisher'][index] ?? 'health',
        status: 'timeout' as const,
        latencyMs: this.config.totalTimeoutMs,
        errorCode: 'HEALTH_TOTAL_TIMEOUT',
      })),
    );
    const componentMap = Object.fromEntries(components.map((component) => [component.component, component]));
    const ready = componentMap.postgres?.status === 'up' && componentMap.sqsInput?.status === 'up';

    return {
      ready,
      status: ready ? 'ok' : 'not_ready',
      checkedAt,
      components: componentMap,
    };
  }

  private async runCheck(name: string, check: () => Promise<HealthComponent>): Promise<HealthComponent> {
    const startedAt = Date.now();
    const component = await withTimeout<HealthComponent>(
      check().catch(() => ({
        component: name,
        status: 'down' as const,
        errorCode: 'HEALTH_CHECK_FAILED',
      })),
      this.config.dependencyTimeoutMs,
      () => ({
        component: name,
        status: 'timeout' as const,
        latencyMs: this.config.dependencyTimeoutMs,
        errorCode: 'HEALTH_CHECK_TIMEOUT',
      }),
    );
    const result = {
      ...component,
      component: name,
      latencyMs: component.latencyMs ?? Date.now() - startedAt,
    };
    this.metrics?.increment('health_checks_total', { component: name, status: result.status });
    this.metrics?.observe?.('health_check_duration_ms', result.latencyMs, {
      component: name,
      status: result.status,
    });
    return result;
  }

  private safeOutboxStatus(): HealthComponent {
    try {
      const result = this.outbox.getStatus();
      this.metrics?.increment('health_checks_total', { component: result.component, status: result.status });
      if (result.latencyMs !== undefined) {
        this.metrics?.observe?.('health_check_duration_ms', result.latencyMs, {
          component: result.component,
          status: result.status,
        });
      }
      return result;
    } catch {
      const result: HealthComponent = {
        component: 'outboxPublisher',
        status: 'degraded',
        errorCode: 'OUTBOX_HEALTH_UNAVAILABLE',
      };
      this.metrics?.increment('health_checks_total', { component: result.component, status: result.status });
      return result;
    }
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: () => T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback()), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

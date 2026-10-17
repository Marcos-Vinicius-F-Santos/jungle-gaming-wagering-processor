export type HealthStatus = 'up' | 'down' | 'timeout' | 'degraded' | 'disabled';

export interface HealthComponent {
  readonly component: string;
  readonly status: HealthStatus;
  readonly latencyMs?: number;
  readonly errorCode?: string;
  readonly pendingCount?: number;
  readonly lagSeconds?: number;
  readonly lastErrorAt?: string;
}

export interface PostgresHealthCheck {
  check(): Promise<HealthComponent>;
}

export interface SqsHealthCheck {
  checkInputQueue(): Promise<HealthComponent>;
  checkEventsQueue(): Promise<HealthComponent>;
}

export interface OutboxPublisherHealth {
  getStatus(): HealthComponent;
}

export const POSTGRES_HEALTH_CHECK = Symbol('POSTGRES_HEALTH_CHECK');
export const SQS_HEALTH_CHECK = Symbol('SQS_HEALTH_CHECK');
export const OUTBOX_PUBLISHER_HEALTH = Symbol('OUTBOX_PUBLISHER_HEALTH');

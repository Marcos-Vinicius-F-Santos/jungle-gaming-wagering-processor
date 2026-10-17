import type { PercentileSummary } from './load-report';

export type MetricUnit = PercentileSummary['unit'];

export interface LoadMetricsSnapshot {
  counters: Readonly<Record<string, number>>;
  observations: Readonly<Record<string, PercentileSummary>>;
  gauges: Readonly<Record<string, number>>;
}

export class LoadMetricsCollector {
  private readonly counters = new Map<string, number>();
  private readonly observations = new Map<string, { unit: MetricUnit; values: number[] }>();
  private readonly gauges = new Map<string, number>();

  increment(name: string, amount = 1): void {
    assertMetricName(name);
    assertFiniteNonNegative(amount, 'counter increment');
    this.counters.set(name, (this.counters.get(name) ?? 0) + amount);
  }

  observe(name: string, value: number, unit: MetricUnit = 'milliseconds'): void {
    assertMetricName(name);
    assertFiniteNonNegative(value, 'observation');
    const current = this.observations.get(name);
    if (current && current.unit !== unit) {
      throw new Error(`Metric ${name} cannot change unit from ${current.unit} to ${unit}`);
    }
    (current?.values ?? this.createObservation(name, unit)).push(value);
  }

  set(name: string, value: number): void {
    assertMetricName(name);
    assertFiniteNonNegative(value, 'gauge');
    this.gauges.set(name, value);
  }

  snapshot(): LoadMetricsSnapshot {
    return {
      counters: Object.fromEntries(this.counters),
      observations: Object.fromEntries(
        [...this.observations.entries()].map(([name, value]) => [name, summarizePercentiles(value.values, value.unit)]),
      ),
      gauges: Object.fromEntries(this.gauges),
    };
  }

  private createObservation(name: string, unit: MetricUnit): number[] {
    const values: number[] = [];
    this.observations.set(name, { unit, values });
    return values;
  }
}

export function summarizePercentiles(values: readonly number[], unit: MetricUnit): PercentileSummary {
  if (values.length === 0) return { count: 0, unit };
  const sorted = [...values].sort((left, right) => left - right);
  return {
    count: sorted.length,
    unit,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    p50: nearestRank(sorted, 0.5),
    p95: nearestRank(sorted, 0.95),
    p99: nearestRank(sorted, 0.99),
  };
}

export function calculateThroughput(count: number, durationSeconds: number): number {
  assertFiniteNonNegative(count, 'throughput count');
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error('throughput duration must be greater than 0');
  }
  return count / durationSeconds;
}

function nearestRank(sorted: readonly number[], percentile: number): number {
  const index = Math.max(0, Math.ceil(percentile * sorted.length) - 1);
  return sorted[index] ?? 0;
}

function assertMetricName(name: string): void {
  if (!/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(name)) {
    throw new Error('metric name must start with a letter and contain at most 128 safe characters');
  }
}

function assertFiniteNonNegative(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be finite and non-negative`);
  }
}

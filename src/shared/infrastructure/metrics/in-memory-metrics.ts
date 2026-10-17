import { Injectable } from '@nestjs/common';

import type { MetricTags, Metrics } from '../../application/ports/metrics.port';

@Injectable()
export class InMemoryMetrics implements Metrics {
  private readonly counters = new Map<string, number>();
  private readonly observations = new Map<string, number[]>();
  private readonly gauges = new Map<string, number>();

  increment(name: string, tags: MetricTags = {}): void {
    const suffix = Object.entries(tags)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${key}=${value}`)
      .join(',');
    const key = suffix ? `${name}{${suffix}}` : name;
    this.counters.set(key, (this.counters.get(key) ?? 0) + 1);
  }

  observe(name: string, value: number, tags: MetricTags = {}): void {
    if (!Number.isFinite(value)) return;
    const key = metricKey(name, tags);
    const values = this.observations.get(key) ?? [];
    values.push(value);
    this.observations.set(key, values);
  }

  set(name: string, value: number, tags: MetricTags = {}): void {
    if (!Number.isFinite(value)) return;
    this.gauges.set(metricKey(name, tags), value);
  }

  snapshot(): ReadonlyMap<string, number> {
    return new Map(this.counters);
  }

  observationsSnapshot(): ReadonlyMap<string, readonly number[]> {
    return new Map([...this.observations.entries()].map(([key, values]) => [key, [...values]] as const));
  }

  gaugeSnapshot(): ReadonlyMap<string, number> {
    return new Map(this.gauges);
  }
}

function metricKey(name: string, tags: MetricTags): string {
  const suffix = Object.entries(tags)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join(',');
  return suffix ? `${name}{${suffix}}` : name;
}

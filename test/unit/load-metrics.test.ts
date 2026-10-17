import { describe, expect, test } from 'bun:test';
import { calculateThroughput, LoadMetricsCollector, summarizePercentiles } from '../load/load-metrics';

describe('load metrics', () => {
  test('aggregates counters, observations and gauges with deterministic percentiles', () => {
    const metrics = new LoadMetricsCollector();
    metrics.increment('requests');
    metrics.increment('requests', 2);
    for (const value of [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]) metrics.observe('latency', value);
    metrics.set('outbox_lag_ms', 12);

    const snapshot = metrics.snapshot();

    expect(snapshot.counters.requests).toBe(3);
    expect(snapshot.observations.latency).toEqual({ count: 10, unit: 'milliseconds', min: 10, max: 100, p50: 50, p95: 100, p99: 100 });
    expect(snapshot.gauges.outbox_lag_ms).toBe(12);
  });

  test('handles empty samples and computes throughput', () => {
    expect(summarizePercentiles([], 'milliseconds')).toEqual({ count: 0, unit: 'milliseconds' });
    expect(calculateThroughput(150, 30)).toBe(5);
  });

  test('rejects invalid values, names, units and durations', () => {
    const metrics = new LoadMetricsCollector();
    expect(() => metrics.increment('requests', -1)).toThrow();
    expect(() => metrics.observe('latency', Number.NaN)).toThrow();
    expect(() => metrics.set('lag', -1)).toThrow();
    expect(() => metrics.increment('1-invalid')).toThrow();
    metrics.observe('same_metric', 1, 'milliseconds');
    expect(() => metrics.observe('same_metric', 1, 'count')).toThrow();
    expect(() => calculateThroughput(1, 0)).toThrow();
  });
});

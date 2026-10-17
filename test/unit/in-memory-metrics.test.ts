import { describe, expect, test } from 'bun:test';

import { InMemoryMetrics } from '../../src/shared/infrastructure/metrics/in-memory-metrics';

describe('InMemoryMetrics', () => {
  test('keeps counters, observations and gauges in stable tagged snapshots', () => {
    const metrics = new InMemoryMetrics();

    metrics.increment('wager_transactions_total', { source: 'HTTP', status: 'PROCESSED' });
    metrics.observe('processing_duration_ms', 12, { source: 'HTTP', operation: 'BET' });
    metrics.observe('processing_duration_ms', 18, { operation: 'BET', source: 'HTTP' });
    metrics.set('outbox_pending_snapshot', 3);
    metrics.set('outbox_pending_snapshot', Number.POSITIVE_INFINITY);

    expect(metrics.snapshot().get('wager_transactions_total{source=HTTP,status=PROCESSED}')).toBe(1);
    expect(metrics.observationsSnapshot().get('processing_duration_ms{operation=BET,source=HTTP}')).toEqual([12, 18]);
    expect(metrics.gaugeSnapshot().get('outbox_pending_snapshot')).toBe(3);
  });

  test('returns copies so callers cannot mutate the adapter state', () => {
    const metrics = new InMemoryMetrics();
    metrics.observe('latency_ms', 10);

    const observations = metrics.observationsSnapshot().get('latency_ms');
    (observations as number[]).push(20);

    expect(metrics.observationsSnapshot().get('latency_ms')).toEqual([10]);
  });
});

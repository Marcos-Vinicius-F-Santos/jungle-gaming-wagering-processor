import { describe, expect, test } from 'bun:test';
import type { Metrics } from '../../src/shared/application/ports/metrics.port';

describe('Metrics port', () => {
  test('keeps counter-only adapters compatible during the contract migration', () => {
    const legacyAdapter: Metrics = {
      increment: () => undefined,
    };

    expect(typeof legacyAdapter.increment).toBe('function');
    expect(legacyAdapter.observe).toBeUndefined();
    expect(legacyAdapter.set).toBeUndefined();
  });

  test('accepts observations and gauge snapshots when an adapter provides them', () => {
    const observations: Array<[string, number]> = [];
    const gauges = new Map<string, number>();
    const adapter: Metrics = {
      increment: () => undefined,
      observe: (name, value) => observations.push([name, value]),
      set: (name, value) => gauges.set(name, value),
    };

    adapter.observe?.('processing_duration_ms', 12);
    adapter.set?.('outbox_pending_snapshot', 3);

    expect(observations).toEqual([['processing_duration_ms', 12]]);
    expect(gauges.get('outbox_pending_snapshot')).toBe(3);
  });
});

import { describe, expect, test } from 'bun:test';
import { readLoadConfig } from '../load/load-config';
import { LoadMetricsCollector } from '../load/load-metrics';
import { runLoad } from '../load/run-load';

describe('run-load orchestration', () => {
  test('writes a failed report and keeps a non-zero outcome when a dependency is unavailable', async () => {
    let closed = false;
    const result = await runLoad(readLoadConfig({
      LOAD_SCENARIO: 'hot-wallet',
      LOAD_WARMUP_SECONDS: '1',
      LOAD_DURATION_SECONDS: '1',
      LOAD_RUN_ID: 'run-failure',
    }), {
      createDriver: () => ({
        metrics: new LoadMetricsCollector(),
        prepare: async () => { throw new Error('database unavailable'); },
        startGenerating: async () => undefined,
        stopGenerating: async () => undefined,
        drain: async () => 0,
        validate: async () => undefined,
        getInvariantReport: () => ({
          passed: false,
          walletsChecked: 0,
          balanceLedgerMismatches: 0,
          duplicateFinancialEffects: 0,
          negativeBalances: 0,
          inboxConflicts: 0,
          outboxFinancialDuplicates: 0,
          unexpectedDeadLetters: 0,
          queueDrained: false,
          details: ['database unavailable'],
        }),
        close: async () => { closed = true; },
      }),
      writeReport: async (report) => {
        expect(report.status).toBe('failed');
        expect(report.scenarios[0]?.status).toBe('failed');
        expect(report.scenarios[0]?.limitations).toContain('database unavailable');
        return { jsonPath: 'failure.json', markdownPath: 'failure.md' };
      },
    });

    expect(result.report.status).toBe('failed');
    expect(closed).toBe(true);
  });
});

import { describe, expect, test } from 'bun:test';
import { readLoadConfig } from '../load/load-config';
import { serializeLoadReport, type LoadReport } from '../load/load-report';

describe('load report contracts', () => {
  test('serializes a complete report with metrics, invariants and limitations', () => {
    const report: LoadReport = {
      schemaVersion: 1,
      runId: 'run-contract',
      generatedAt: '2026-10-16T00:00:00.000Z',
      status: 'passed',
      config: readLoadConfig({ LOAD_RUN_ID: 'run-contract' }),
      environment: {
        applicationVersion: '0.1.0',
        nodeVersion: 'v22',
        bunVersion: '1.4.3',
        composeProject: 'junglegaming',
        database: 'postgresql:16-alpine',
        broker: 'localstack:3.8.1',
        instances: 3,
      },
      scenarios: [{
        scenarioId: 'distributed-throughput',
        status: 'passed',
        startedAt: '2026-10-16T00:00:00.000Z',
        endedAt: '2026-10-16T00:02:30.000Z',
        warmupSeconds: 30,
        durationSeconds: 120,
        drainDurationMs: 400,
        counters: {
          sent: 10,
          accepted: 10,
          processed: 10,
          rejected: 0,
          pending: 0,
          failed: 0,
          retries: 0,
          redeliveries: 0,
          replays: 0,
          lockConflicts: 0,
          recoveredLeases: 0,
          deadLettered: 0,
        },
        latency: {
          processing: { count: 10, unit: 'milliseconds', min: 4, max: 20, p50: 8, p95: 18, p99: 20 },
        },
        errors: {},
        gauges: { outboxLagMs: 20 },
        invariants: {
          passed: true,
          walletsChecked: 10,
          balanceLedgerMismatches: 0,
          duplicateFinancialEffects: 0,
          negativeBalances: 0,
          inboxConflicts: 0,
          outboxFinancialDuplicates: 0,
          unexpectedDeadLetters: 0,
          queueDrained: true,
          details: [],
        },
        limitations: ['local Docker host'],
      }],
      limitations: ['not a production capacity guarantee'],
    };

    const serialized = serializeLoadReport(report);
    const parsed = JSON.parse(serialized) as LoadReport;

    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.scenarios[0]?.latency.processing.p99).toBe(20);
    expect(parsed.scenarios[0]?.invariants.passed).toBe(true);
    expect(serialized).not.toContain('payload');
  });
});

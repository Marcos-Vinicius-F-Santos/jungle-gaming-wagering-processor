import { describe, expect, test } from 'bun:test';
import { readLoadConfig } from '../load/load-config';

describe('readLoadConfig', () => {
  test('uses safe defaults and creates an isolated run id', () => {
    const config = readLoadConfig({});

    expect(config.scenario).toBe('all');
    expect(config.warmupSeconds).toBe(30);
    expect(config.durationSeconds).toBe(120);
    expect(config.drainTimeoutSeconds).toBe(60);
    expect(config.concurrency).toBe(3);
    expect(config.ratePerSecond).toBeUndefined();
    expect(config.runId.startsWith('load-')).toBe(true);
    expect(config.reportDir.endsWith('artifacts\\load') || config.reportDir.endsWith('artifacts/load')).toBe(true);
    expect(config.keepEnvironment).toBe(false);
  });

  test('accepts a selected scenario and operational overrides', () => {
    const config = readLoadConfig({
      LOAD_SCENARIO: 'hot-wallet',
      LOAD_WARMUP_SECONDS: '5',
      LOAD_DURATION_SECONDS: '90',
      LOAD_DRAIN_TIMEOUT_SECONDS: '45',
      LOAD_CONCURRENCY: '12',
      LOAD_RATE_PER_SECOND: '25.5',
      LOAD_RUN_ID: 'run-20261016-hot',
      LOAD_REPORT_DIR: 'artifacts/custom-load',
      LOAD_KEEP_ENVIRONMENT: 'true',
    });

    expect(config).toMatchObject({
      scenario: 'hot-wallet',
      warmupSeconds: 5,
      durationSeconds: 90,
      drainTimeoutSeconds: 45,
      concurrency: 12,
      ratePerSecond: 25.5,
      runId: 'run-20261016-hot',
      keepEnvironment: true,
    });
    expect(config.reportDir.endsWith('artifacts\\custom-load') || config.reportDir.endsWith('artifacts/custom-load')).toBe(true);
  });

  test('rejects invalid scenario, bounds, rate, run id and boolean', () => {
    const invalid = [
      { LOAD_SCENARIO: 'unknown' },
      { LOAD_DURATION_SECONDS: '0' },
      { LOAD_CONCURRENCY: '1.5' },
      { LOAD_RATE_PER_SECOND: '0' },
      { LOAD_RUN_ID: '../outside' },
      { LOAD_KEEP_ENVIRONMENT: 'yes' },
    ];

    for (const env of invalid) {
      expect(() => readLoadConfig(env)).toThrow();
    }
  });
});

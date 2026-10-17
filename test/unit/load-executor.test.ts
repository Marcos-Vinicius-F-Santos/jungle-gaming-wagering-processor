import { describe, expect, test } from 'bun:test';
import { executeScenarioCycle, type LoadScenarioDriver, type ScenarioCycleClock } from '../load/load-executor';

describe('load scenario executor', () => {
  test('runs prepare, warmup, measurement, drain and validation in order', async () => {
    const events: string[] = [];
    let now = 1_000;
    const driver: LoadScenarioDriver = {
      prepare: async () => { events.push('prepare'); },
      startGenerating: async (phase) => { events.push(`start:${phase}`); },
      stopGenerating: async () => { events.push('stop'); },
      drain: async (timeoutMs) => { events.push(`drain:${timeoutMs}`); return 12; },
      validate: async () => { events.push('validate'); },
    };
    const clock: ScenarioCycleClock = {
      now: () => now,
      sleep: async (milliseconds) => { events.push(`sleep:${milliseconds}`); now += milliseconds; },
    };

    const result = await executeScenarioCycle('distributed-throughput', {
      warmupSeconds: 2,
      durationSeconds: 5,
      drainTimeoutSeconds: 9,
    }, driver, clock);

    expect(events).toEqual([
      'prepare',
      'start:warmup',
      'sleep:2000',
      'stop',
      'start:measurement',
      'sleep:5000',
      'stop',
      'drain:9000',
      'validate',
    ]);
    expect(result).toMatchObject({ scenarioId: 'distributed-throughput', status: 'passed', warmupSeconds: 2, durationSeconds: 5, drainDurationMs: 12 });
  });

  test('stops generation when the measurement fails', async () => {
    const events: string[] = [];
    const driver: LoadScenarioDriver = {
      prepare: async () => undefined,
      startGenerating: async (phase) => { events.push(`start:${phase}`); },
      stopGenerating: async () => { events.push('stop'); },
      drain: async () => 0,
      validate: async () => undefined,
    };

    await expect(executeScenarioCycle('hot-wallet', { warmupSeconds: 1, durationSeconds: 1, drainTimeoutSeconds: 1 }, driver, {
      now: () => 1_000,
      sleep: async (milliseconds) => {
        if (milliseconds === 1_000 && events.length === 1) throw new Error('generator failed');
      },
    })).rejects.toThrow('generator failed');
    expect(events).toEqual(['start:warmup', 'stop']);
  });

  test('interrupts a running phase when the stop signal is observed', async () => {
    const events: string[] = [];
    let interrupted = false;
    let now = 1_000;
    const driver: LoadScenarioDriver = {
      prepare: async () => undefined,
      startGenerating: async (phase) => { events.push(`start:${phase}`); },
      stopGenerating: async () => { events.push('stop'); },
      drain: async () => 0,
      validate: async () => undefined,
    };

    await expect(executeScenarioCycle('outbox-pressure', { warmupSeconds: 5, durationSeconds: 1, drainTimeoutSeconds: 1 }, driver, {
      now: () => now,
      sleep: async (milliseconds) => { now += milliseconds; interrupted = true; },
    }, { shouldStop: () => interrupted })).rejects.toThrow('load run interrupted');
    expect(events).toEqual(['start:warmup', 'stop']);
  });
});

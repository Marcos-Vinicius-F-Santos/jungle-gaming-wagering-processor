import type { LoadConfig } from './load-config';

export type LoadScenarioPhase = 'prepare' | 'warmup' | 'measurement' | 'drain' | 'complete';

export interface LoadScenarioDriver {
  prepare(): Promise<void>;
  startGenerating(phase: 'warmup' | 'measurement'): Promise<void>;
  stopGenerating(): Promise<void>;
  drain(timeoutMs: number): Promise<number>;
  validate(): Promise<void>;
}

export interface ScenarioCycleResult {
  scenarioId: string;
  status: 'passed';
  startedAt: string;
  endedAt: string;
  warmupSeconds: number;
  durationSeconds: number;
  drainDurationMs: number;
}

export interface ScenarioCycleClock {
  now(): number;
  sleep(milliseconds: number): Promise<void>;
}

export interface ScenarioCycleOptions {
  shouldStop?: () => boolean;
}

export async function executeScenarioCycle(
  scenarioId: string,
  config: Pick<LoadConfig, 'warmupSeconds' | 'durationSeconds' | 'drainTimeoutSeconds'>,
  driver: LoadScenarioDriver,
  clock: ScenarioCycleClock = systemClock,
  options: ScenarioCycleOptions = {},
): Promise<ScenarioCycleResult> {
  const startedAtEpochMs = clock.now();
  let generating = false;
  try {
    await driver.prepare();
    await driver.startGenerating('warmup');
    generating = true;
    await sleepPhase(clock, config.warmupSeconds * 1_000, options.shouldStop);
    await driver.stopGenerating();
    generating = false;

    await driver.startGenerating('measurement');
    generating = true;
    await sleepPhase(clock, config.durationSeconds * 1_000, options.shouldStop);
    await driver.stopGenerating();
    generating = false;

    const drainStartedAt = clock.now();
    const drainDurationMs = await driver.drain(config.drainTimeoutSeconds * 1_000);
    const reportedDrainDurationMs = Math.max(drainDurationMs, clock.now() - drainStartedAt);
    await driver.validate();

    return {
      scenarioId,
      status: 'passed',
      startedAt: new Date(startedAtEpochMs).toISOString(),
      endedAt: new Date(clock.now()).toISOString(),
      warmupSeconds: config.warmupSeconds,
      durationSeconds: config.durationSeconds,
      drainDurationMs: reportedDrainDurationMs,
    };
  } finally {
    if (generating) await driver.stopGenerating();
  }
}

const systemClock: ScenarioCycleClock = {
  now: () => Date.now(),
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
};

async function sleepPhase(clock: ScenarioCycleClock, durationMs: number, shouldStop?: () => boolean): Promise<void> {
  if (!shouldStop) {
    await clock.sleep(durationMs);
    return;
  }
  const deadline = clock.now() + durationMs;
  while (clock.now() < deadline) {
    if (shouldStop()) throw new Error('load run interrupted');
    await clock.sleep(Math.min(250, deadline - clock.now()));
  }
  if (shouldStop()) throw new Error('load run interrupted');
}

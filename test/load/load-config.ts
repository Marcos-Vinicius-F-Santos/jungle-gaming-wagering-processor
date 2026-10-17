import { resolve } from 'node:path';
import { v7 as uuidv7 } from 'uuid';

export const LOAD_SCENARIOS = [
  'all',
  'distributed-throughput',
  'hot-wallet',
  'replay-redelivery',
  'outbox-pressure',
] as const;

export type LoadScenario = (typeof LOAD_SCENARIOS)[number];

export interface LoadConfig {
  scenario: LoadScenario;
  warmupSeconds: number;
  durationSeconds: number;
  drainTimeoutSeconds: number;
  concurrency: number;
  ratePerSecond?: number;
  runId: string;
  reportDir: string;
  keepEnvironment: boolean;
}

export const DEFAULT_LOAD_CONFIG = {
  scenario: 'all' as const,
  warmupSeconds: 30,
  durationSeconds: 120,
  drainTimeoutSeconds: 60,
  concurrency: 3,
  reportDir: 'artifacts/load',
  keepEnvironment: false,
};

export function readLoadConfig(env: NodeJS.ProcessEnv = process.env): LoadConfig {
  const scenario = readScenario(env.LOAD_SCENARIO);
  const warmupSeconds = readInteger(env.LOAD_WARMUP_SECONDS, DEFAULT_LOAD_CONFIG.warmupSeconds, 1, 3_600, 'LOAD_WARMUP_SECONDS');
  const durationSeconds = readInteger(env.LOAD_DURATION_SECONDS, DEFAULT_LOAD_CONFIG.durationSeconds, 1, 3_600, 'LOAD_DURATION_SECONDS');
  const drainTimeoutSeconds = readInteger(
    env.LOAD_DRAIN_TIMEOUT_SECONDS,
    DEFAULT_LOAD_CONFIG.drainTimeoutSeconds,
    1,
    3_600,
    'LOAD_DRAIN_TIMEOUT_SECONDS',
  );
  const concurrency = readInteger(env.LOAD_CONCURRENCY, DEFAULT_LOAD_CONFIG.concurrency, 1, 1_000, 'LOAD_CONCURRENCY');
  const ratePerSecond = env.LOAD_RATE_PER_SECOND === undefined
    ? undefined
    : readRate(env.LOAD_RATE_PER_SECOND);
  const runId = readRunId(env.LOAD_RUN_ID ?? `load-${uuidv7()}`);
  const reportDir = readReportDir(env.LOAD_REPORT_DIR ?? DEFAULT_LOAD_CONFIG.reportDir);

  return {
    scenario,
    warmupSeconds,
    durationSeconds,
    drainTimeoutSeconds,
    concurrency,
    ...(ratePerSecond === undefined ? {} : { ratePerSecond }),
    runId,
    reportDir,
    keepEnvironment: readBoolean(env.LOAD_KEEP_ENVIRONMENT, false, 'LOAD_KEEP_ENVIRONMENT'),
  };
}

function readScenario(value: string | undefined): LoadScenario {
  const scenario = value ?? DEFAULT_LOAD_CONFIG.scenario;
  if ((LOAD_SCENARIOS as readonly string[]).includes(scenario)) {
    return scenario as LoadScenario;
  }
  throw new Error(`LOAD_SCENARIO must be one of: ${LOAD_SCENARIOS.join(', ')}`);
}

function readInteger(value: string | undefined, fallback: number, min: number, max: number, name: string): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function readRate(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 100_000) {
    throw new Error('LOAD_RATE_PER_SECOND must be greater than 0 and at most 100000');
  }
  return parsed;
}

function readRunId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(value)) {
    throw new Error('LOAD_RUN_ID must contain 1 to 80 safe alphanumeric, dot, underscore or hyphen characters');
  }
  return value;
}

function readReportDir(value: string): string {
  if (value.trim().length === 0 || value.length > 240) {
    throw new Error('LOAD_REPORT_DIR must be a non-empty path with at most 240 characters');
  }
  return resolve(value);
}

function readBoolean(value: string | undefined, fallback: boolean, name: string): boolean {
  if (value === undefined) return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${name} must be true or false`);
}

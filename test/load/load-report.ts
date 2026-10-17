import type { LoadConfig, LoadScenario } from './load-config';

export type LoadScenarioStatus = 'passed' | 'failed' | 'interrupted';
export type LoadOutcome = 'accepted' | 'processed' | 'rejected' | 'pending' | 'failed' | 'timeout';

export interface LoadSample {
  scenarioId: Exclude<LoadScenario, 'all'>;
  operation: string;
  outcome: LoadOutcome;
  startedAtEpochMs: number;
  durationMs: number;
  statusCode?: number;
  retryCount?: number;
}

export interface PercentileSummary {
  count: number;
  unit: 'milliseconds' | 'operations_per_second' | 'count';
  min?: number;
  max?: number;
  p50?: number;
  p95?: number;
  p99?: number;
}

export interface LoadCounters {
  sent: number;
  accepted: number;
  processed: number;
  rejected: number;
  pending: number;
  failed: number;
  retries: number;
  redeliveries: number;
  replays: number;
  lockConflicts: number;
  recoveredLeases: number;
  deadLettered: number;
}

export interface LoadInvariantReport {
  passed: boolean;
  walletsChecked: number;
  balanceLedgerMismatches: number;
  duplicateFinancialEffects: number;
  negativeBalances: number;
  inboxConflicts: number;
  outboxFinancialDuplicates: number;
  unexpectedDeadLetters: number;
  queueDrained: boolean;
  details: readonly string[];
}

export interface LoadScenarioReport {
  scenarioId: Exclude<LoadScenario, 'all'>;
  status: LoadScenarioStatus;
  startedAt: string;
  endedAt: string;
  warmupSeconds: number;
  durationSeconds: number;
  drainDurationMs: number;
  counters: LoadCounters;
  latency: Readonly<Record<string, PercentileSummary>>;
  errors: Readonly<Record<string, number>>;
  gauges: Readonly<Record<string, number>>;
  invariants: LoadInvariantReport;
  limitations: readonly string[];
}

export interface LoadEnvironment {
  applicationVersion: string;
  nodeVersion: string;
  bunVersion: string;
  composeProject: string;
  database: string;
  broker: string;
  instances: number;
  host?: string;
}

export interface LoadReport {
  schemaVersion: 1;
  runId: string;
  generatedAt: string;
  status: LoadScenarioStatus;
  config: LoadConfig;
  environment: LoadEnvironment;
  scenarios: readonly LoadScenarioReport[];
  limitations: readonly string[];
}

export function serializeLoadReport(report: LoadReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

import { readLoadConfig, type LoadConfig, type LoadScenario } from './load-config';
import { executeScenarioCycle, type LoadScenarioDriver } from './load-executor';
import { LoadMetricsCollector, calculateThroughput } from './load-metrics';
import { writeLoadReport } from './load-report-writer';
import type { LoadCounters, LoadEnvironment, LoadInvariantReport, LoadReport, LoadScenarioReport } from './load-report';
import { DistributedThroughputScenario } from './scenarios/distributed-throughput';
import { HotWalletScenario } from './scenarios/hot-wallet';
import { ReplayRedeliveryScenario } from './scenarios/replay-redelivery';
import { OutboxPressureScenario } from './scenarios/outbox-pressure';

const SCENARIOS: Exclude<LoadScenario, 'all'>[] = [
  'distributed-throughput',
  'hot-wallet',
  'replay-redelivery',
  'outbox-pressure',
];

interface ObservableScenarioDriver extends LoadScenarioDriver {
  readonly metrics: LoadMetricsCollector;
  getInvariantReport(): LoadInvariantReport;
  close(): Promise<void>;
}

export interface LoadRunnerDependencies {
  createDriver?: (scenarioId: Exclude<LoadScenario, 'all'>, config: LoadConfig) => ObservableScenarioDriver;
  writeReport?: typeof writeLoadReport;
}

export async function runLoad(config: LoadConfig = readLoadConfig(), dependencies: LoadRunnerDependencies = {}): Promise<{ report: LoadReport; jsonPath: string; markdownPath: string }> {
  const scenarioIds = config.scenario === 'all' ? SCENARIOS : [config.scenario];
  const scenarios: LoadScenarioReport[] = [];
  let interrupted = false;
  let activeDriver: ObservableScenarioDriver | undefined;
  const handleInterrupt = () => {
    interrupted = true;
    void activeDriver?.stopGenerating();
  };
  process.once('SIGINT', handleInterrupt);
  process.once('SIGTERM', handleInterrupt);

  try {
    for (const scenarioId of scenarioIds) {
      if (interrupted) break;
      const driver = (dependencies.createDriver ?? createScenario)(scenarioId, config);
      activeDriver = driver;
      scenarios.push(await runScenario(scenarioId, config, driver, () => interrupted));
      activeDriver = undefined;
    }
  } finally {
    process.removeListener('SIGINT', handleInterrupt);
    process.removeListener('SIGTERM', handleInterrupt);
  }

  const report: LoadReport = {
    schemaVersion: 1,
    runId: config.runId,
    generatedAt: new Date().toISOString(),
    status: interrupted ? 'interrupted' : scenarios.every((scenario) => scenario.status === 'passed') ? 'passed' : 'failed',
    config,
    environment: readEnvironment(),
    scenarios,
    limitations: [
      'A execução mede o caminho SQS/Inbox/Outbox; latência HTTP não é coletada por estes cenários.',
      'CPU e memória do host não são coletadas automaticamente nesta primeira versão do runner.',
      'A taxa observada depende dos limites locais de PostgreSQL, LocalStack, Docker e do host.',
    ],
  };
  const paths = await (dependencies.writeReport ?? writeLoadReport)(report);
  console.log(`Load run ${config.runId}: ${report.status}`);
  console.log(`Scenarios: ${scenarios.map((scenario) => `${scenario.scenarioId}=${scenario.status}`).join(', ')}`);
  console.log(`Report JSON: ${paths.jsonPath}`);
  console.log(`Report Markdown: ${paths.markdownPath}`);
  return { report, ...paths };
}

async function runScenario(
  scenarioId: Exclude<LoadScenario, 'all'>,
  config: LoadConfig,
  driver: ObservableScenarioDriver,
  shouldStop: () => boolean,
): Promise<LoadScenarioReport> {
  const startedAt = new Date().toISOString();
  try {
    const cycle = await executeScenarioCycle(scenarioId, config, driver, undefined, { shouldStop });
    return buildScenarioReport(scenarioId, driver, config, cycle.startedAt, cycle.endedAt, cycle.drainDurationMs, 'passed');
  } catch (error) {
    const endedAt = new Date().toISOString();
    const message = error instanceof Error ? error.message : String(error);
    return buildScenarioReport(scenarioId, driver, config, startedAt, endedAt, 0, shouldStop() ? 'interrupted' : 'failed', [message]);
  } finally {
    await driver.close();
  }
}

function createScenario(scenarioId: Exclude<LoadScenario, 'all'>, config: LoadConfig): ObservableScenarioDriver {
  switch (scenarioId) {
    case 'distributed-throughput': return new DistributedThroughputScenario(config);
    case 'hot-wallet': return new HotWalletScenario(config);
    case 'replay-redelivery': return new ReplayRedeliveryScenario(config);
    case 'outbox-pressure': return new OutboxPressureScenario(config);
  }
}

function buildScenarioReport(
  scenarioId: Exclude<LoadScenario, 'all'>,
  driver: ObservableScenarioDriver,
  config: LoadConfig,
  startedAt: string,
  endedAt: string,
  drainDurationMs: number,
  status: 'passed' | 'failed' | 'interrupted',
  errors: readonly string[] = [],
): LoadScenarioReport {
  const snapshot = driver.metrics.snapshot();
  const sent = firstCounter(snapshot.counters, 'operations_sent', 'replays');
  const failed = firstCounter(snapshot.counters, 'operations_failed');
  const invariantReport = driver.getInvariantReport();
  const processed = invariantReport.queueDrained && invariantReport.passed ? Math.max(0, sent - failed) : 0;
  const counters: LoadCounters = {
    sent,
    accepted: Math.max(0, sent - failed),
    processed,
    rejected: 0,
    pending: invariantReport.queueDrained ? 0 : 1,
    failed,
    retries: firstCounter(snapshot.counters, 'retries'),
    redeliveries: firstCounter(snapshot.counters, 'redeliveries'),
    replays: firstCounter(snapshot.counters, 'replays'),
    lockConflicts: firstCounter(snapshot.counters, 'lock_conflicts'),
    recoveredLeases: firstCounter(snapshot.counters, 'recovered_leases'),
    deadLettered: invariantReport.unexpectedDeadLetters,
  };
  const latency = { ...snapshot.observations };
  const throughput = calculateThroughput(counters.processed, config.durationSeconds);
  return {
    scenarioId,
    status,
    startedAt,
    endedAt,
    warmupSeconds: config.warmupSeconds,
    durationSeconds: config.durationSeconds,
    drainDurationMs,
    counters,
    latency,
    errors: errors.length > 0 ? { runner: errors.length } : {},
    gauges: { ...snapshot.gauges, processed_per_second: throughput },
    invariants: invariantReport,
    limitations: errors.length > 0 ? errors : ['Contadores de processamento são inferidos a partir da drenagem e serão refinados na matriz completa.'],
  };
}

function firstCounter(counters: Readonly<Record<string, number>>, ...names: string[]): number {
  return names.reduce((value, name) => value || counters[name] || 0, 0);
}

function readEnvironment(): LoadEnvironment {
  return {
    applicationVersion: process.env.npm_package_version ?? '0.1.0',
    nodeVersion: process.version,
    bunVersion: process.versions.bun ?? 'unknown',
    composeProject: process.env.COMPOSE_PROJECT_NAME ?? 'jungleGaming',
    database: process.env.LOAD_DATABASE_URL ?? 'postgresql://wagering@127.0.0.1:15432/wagering',
    broker: process.env.LOAD_SQS_ENDPOINT ?? 'http://127.0.0.1:14566',
    instances: 3,
    host: process.env.COMPOSE_HOST,
  };
}

if (process.argv[1] && /run-load\.(ts|js)$/.test(process.argv[1])) {
  runLoad().then(({ report }) => {
    if (report.status !== 'passed') process.exitCode = 1;
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

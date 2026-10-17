import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import type { LoadReport, LoadScenarioReport } from './load-report';
import { serializeLoadReport } from './load-report';

export interface LoadReportPaths {
  jsonPath: string;
  markdownPath: string;
}

export async function writeLoadReport(report: LoadReport): Promise<LoadReportPaths> {
  const directory = resolve(report.config.reportDir);
  const baseName = safeFileName(report.runId);
  const jsonPath = childPath(directory, `${baseName}.json`);
  const markdownPath = childPath(directory, `${baseName}.md`);
  await mkdir(directory, { recursive: true });
  await writeFile(jsonPath, serializeLoadReport(report), 'utf8');
  await writeFile(markdownPath, renderLoadReportMarkdown(report), 'utf8');
  return { jsonPath, markdownPath };
}

export function renderLoadReportMarkdown(report: LoadReport): string {
  const lines = [
    `# Load report — ${report.runId}`,
    '',
    `- Status: ${report.status}`,
    `- Generated at: ${report.generatedAt}`,
    `- Instances: ${report.environment.instances}`,
    `- Database: ${report.environment.database}`,
    `- Broker: ${report.environment.broker}`,
    '',
    '## Scenarios',
    '',
  ];

  for (const scenario of report.scenarios) lines.push(...renderScenario(scenario));
  lines.push('', '## Limitations', '', ...(report.limitations.length > 0 ? report.limitations.map((item) => `- ${item}`) : ['- none recorded']), '');
  return lines.join('\n');
}

export function assertRunOwned(runId: string, value: string): void {
  const prefix = `load-${runId}-`;
  if (!value.startsWith(prefix)) {
    throw new Error(`refusing to operate on data outside run ${runId}`);
  }
}

function renderScenario(scenario: LoadScenarioReport): string[] {
  const lines = [
    `### ${scenario.scenarioId}`,
    '',
    `- Status: ${scenario.status}`,
    `- Warmup: ${scenario.warmupSeconds}s`,
    `- Measurement: ${scenario.durationSeconds}s`,
    `- Drain: ${scenario.drainDurationMs}ms`,
    `- Sent / processed / failed: ${scenario.counters.sent} / ${scenario.counters.processed} / ${scenario.counters.failed}`,
    `- Invariants: ${scenario.invariants.passed ? 'passed' : 'failed'}`,
    `- Queue drained: ${scenario.invariants.queueDrained ? 'yes' : 'no'}`,
  ];
  for (const [name, metric] of Object.entries(scenario.latency)) {
    lines.push(`- ${name} p50/p95/p99: ${metric.p50 ?? 'n/a'} / ${metric.p95 ?? 'n/a'} / ${metric.p99 ?? 'n/a'} ${metric.unit}`);
  }
  if (scenario.limitations.length > 0) lines.push(`- Limitations: ${scenario.limitations.join('; ')}`);
  lines.push('');
  return lines;
}

function safeFileName(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(value)) throw new Error('report run id is not safe for a file name');
  return value;
}

function childPath(directory: string, fileName: string): string {
  const target = resolve(directory, fileName);
  const relativeTarget = relative(directory, target);
  if (isAbsolute(relativeTarget) || relativeTarget.startsWith('..')) {
    throw new Error('report path escaped its report directory');
  }
  return target;
}

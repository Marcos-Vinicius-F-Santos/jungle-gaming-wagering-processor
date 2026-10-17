import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { readLoadConfig } from '../load/load-config';
import { writeLoadReport, assertRunOwned, renderLoadReportMarkdown } from '../load/load-report-writer';
import type { LoadReport } from '../load/load-report';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('load report writer', () => {
  test('writes JSON and Markdown reports and keeps partial status visible', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jungle-load-'));
    temporaryDirectories.push(directory);
    const report: LoadReport = {
      schemaVersion: 1,
      runId: 'writer-run',
      generatedAt: '2026-10-16T00:00:00.000Z',
      status: 'interrupted',
      config: readLoadConfig({ LOAD_RUN_ID: 'writer-run', LOAD_REPORT_DIR: directory }),
      environment: {
        applicationVersion: '0.1.0',
        nodeVersion: 'v22',
        bunVersion: '1.4.3',
        composeProject: 'junglegaming',
        database: 'postgresql:16-alpine',
        broker: 'localstack:3.8.1',
        instances: 3,
      },
      scenarios: [],
      limitations: ['interrupted by test'],
    };

    const paths = await writeLoadReport(report);
    const json = JSON.parse(await readFile(paths.jsonPath, 'utf8')) as LoadReport;
    const markdown = await readFile(paths.markdownPath, 'utf8');

    expect(json.status).toBe('interrupted');
    expect(markdown).toContain('writer-run');
    expect(markdown).toContain('interrupted by test');
    expect(paths.jsonPath.startsWith(directory)).toBe(true);
  });

  test('renders an explicit empty limitation and protects run-scoped identifiers', () => {
    const markdown = renderLoadReportMarkdown({
      schemaVersion: 1,
      runId: 'safe-run',
      generatedAt: '2026-10-16T00:00:00.000Z',
      status: 'passed',
      config: readLoadConfig({ LOAD_RUN_ID: 'safe-run' }),
      environment: { applicationVersion: '0.1.0', nodeVersion: 'v22', bunVersion: '1.4.3', composeProject: 'test', database: 'pg', broker: 'sqs', instances: 3 },
      scenarios: [],
      limitations: [],
    });

    expect(markdown).toContain('- none recorded');
    expect(() => assertRunOwned('safe-run', 'load-safe-run-scenario-wallet-1')).not.toThrow();
    expect(() => assertRunOwned('safe-run', 'load-other-run-scenario-wallet-1')).toThrow();
  });
});

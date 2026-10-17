const root = process.cwd();
const baseCompose = 'docker-compose.resilience.yml';
const resilienceProject = 'jungle-gaming-resilience';
const resiliencePostgresPort = '25432';
const resilienceSqsPort = '24566';
const resilienceSqsEndpoint = `http://127.0.0.1:${resilienceSqsPort}`;
const resilienceEnvironment = {
  ...process.env,
  RESILIENCE_POSTGRES_PORT: resiliencePostgresPort,
  RESILIENCE_SQS_PORT: resilienceSqsPort,
  RESILIENCE_DATABASE_URL: `postgresql://wagering:wagering@127.0.0.1:${resiliencePostgresPort}/wagering`,
  RESILIENCE_SQS_ENDPOINT: resilienceSqsEndpoint,
  RESILIENCE_QUEUE_URL: `${resilienceSqsEndpoint}/000000000000/wager-transactions.fifo`,
};

interface Scenario {
  readonly name: string;
  readonly testFile: string;
  readonly override?: string;
}

interface ScenarioResult {
  readonly run: number;
  readonly name: string;
  readonly durationMs: number;
  readonly status: 'passed' | 'failed';
}

const scenarios: readonly Scenario[] = [
  { name: 'baseline-harness', testFile: 'test/resilience/resilience.harness.test.ts' },
  { name: 'three-instance-concurrency', testFile: 'test/resilience/resilience.concurrency.test.ts' },
  {
    name: 'crash-before-commit',
    testFile: 'test/resilience/resilience.crash-before-commit.test.ts',
    override: 'docker-compose.resilience.before-commit.yml',
  },
  {
    name: 'crash-after-commit-before-ack',
    testFile: 'test/resilience/resilience.crash-after-commit.test.ts',
    override: 'docker-compose.resilience.after-commit.yml',
  },
  {
    name: 'lease-recovery-after-restart',
    testFile: 'test/resilience/resilience.lease-recovery.test.ts',
    override: 'docker-compose.resilience.lease-recovery.yml',
  },
  {
    name: 'sigterm-drain',
    testFile: 'test/resilience/resilience.sigterm.test.ts',
    override: 'docker-compose.resilience.sigterm.yml',
  },
  {
    name: 'transient-and-poison-failures',
    testFile: 'test/resilience/resilience.failures.test.ts',
    override: 'docker-compose.resilience.failures.yml',
  },
];

const results: ScenarioResult[] = [];
let failed = false;

for (let run = 1; run <= 2; run += 1) {
  console.log(`\n[resilience] run ${run}/2: resetting containers and starting base`);
  const reset = runDocker(['compose', '-f', baseCompose, 'down', '--remove-orphans']);
  if (reset.status !== 0) {
    console.error(`[resilience] cleanup failed: ${reset.stderr}`);
    failed = true;
    break;
  }

  const base = runDocker(['compose', '-f', baseCompose, 'up', '-d', '--build']);
  if (base.status !== 0 || !waitForHealthy()) {
    console.error(`[resilience] base startup failed: ${base.stderr}`);
    failed = true;
    break;
  }

  for (const scenario of scenarios) {
    const startedAt = Date.now();
    if (scenario.override) {
      const overlay = runDocker([
        'compose', '-f', baseCompose, '-f', scenario.override, 'up', '-d',
      ]);
      if (overlay.status !== 0) {
        results.push({ run, name: scenario.name, durationMs: Date.now() - startedAt, status: 'failed' });
        console.error(`[resilience] ${scenario.name}: overlay failed`);
        failed = true;
        break;
      }
    }

    const test = runBunTest(scenario.testFile);
    const status = test.status === 0 ? 'passed' : 'failed';
    results.push({ run, name: scenario.name, durationMs: Date.now() - startedAt, status });
    console.log(`[resilience] run=${run} scenario=${scenario.name} status=${status} durationMs=${Date.now() - startedAt}`);
    if (test.status !== 0) {
      console.error(test.stderr || test.stdout);
      failed = true;
    }

    const restore = runDocker(['compose', '-f', baseCompose, 'up', '-d']);
    if (restore.status !== 0 || !waitForHealthy()) {
      console.error(`[resilience] base restore failed after ${scenario.name}: ${restore.stderr}`);
      failed = true;
      break;
    }
    if (failed) break;
  }
  if (failed) break;
}

const finalCleanup = runDocker(['compose', '-f', baseCompose, 'down', '--remove-orphans']);
if (finalCleanup.status !== 0) {
  console.error(`[resilience] final cleanup failed: ${finalCleanup.stderr}`);
  failed = true;
}

console.log('\n[resilience] summary');
for (const result of results) {
  console.log(`- run=${result.run} scenario=${result.name} status=${result.status} durationMs=${result.durationMs}`);
}
if (failed) process.exitCode = 1;

function runBunTest(testFile: string): CommandResult {
  return runCommand(['bun', 'test', testFile]);
}

function runDocker(args: string[]): CommandResult {
  const command = args[0] === 'compose'
    ? ['docker', 'compose', '-p', resilienceProject, ...args.slice(1)]
    : ['docker', ...args];
  return runCommand(command);
}

function runCommand(cmd: string[]): CommandResult {
  const result = Bun.spawnSync({ cmd, cwd: root, env: resilienceEnvironment });
  return {
    status: result.exitCode,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

function waitForHealthy(): boolean {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const healthy = ['resilience-app-1', 'resilience-app-2', 'resilience-app-3'].every((service) => {
      const id = runDocker(['compose', '-f', baseCompose, 'ps', '-q', service]).stdout.trim();
      if (!id) return false;
      const state = runDocker(['inspect', '--format', '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}', id]);
      return state.stdout.trim() === 'running|healthy';
    });
    if (healthy) return true;
    Bun.sleepSync(500);
  }
  return false;
}

interface CommandResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

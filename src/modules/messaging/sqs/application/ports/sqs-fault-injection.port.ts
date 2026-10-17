export type SqsFaultPoint = 'BEFORE_COMMIT' | 'AFTER_COMMIT_BEFORE_ACK' | 'DURING_SHUTDOWN';

export interface SqsFaultInjection {
  checkpoint(point: SqsFaultPoint): Promise<void>;
}

export const SQS_FAULT_INJECTION = Symbol('SQS_FAULT_INJECTION');

export class SqsInjectedCrashError extends Error {
  constructor(readonly point: SqsFaultPoint) {
    super(`SQS_TEST_FAULT_${point}`);
    this.name = 'SqsInjectedCrashError';
  }
}

export class DisabledSqsFaultInjection implements SqsFaultInjection {
  async checkpoint(_point: SqsFaultPoint): Promise<void> {}
}

export class ConfiguredSqsFaultInjection implements SqsFaultInjection {
  async checkpoint(point: SqsFaultPoint): Promise<void> {
    if (process.env.SQS_TEST_FAULT_ENABLED !== 'true') return;
    if (process.env.SQS_TEST_FAULT_POINT !== point) return;
    if (process.env.SQS_TEST_FAULT_ACTION === 'KILL') {
      process.kill(process.pid, 'SIGKILL');
      return;
    }
    throw new SqsInjectedCrashError(point);
  }
}

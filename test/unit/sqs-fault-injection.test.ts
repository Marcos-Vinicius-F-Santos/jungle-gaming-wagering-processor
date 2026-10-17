import { afterEach, describe, expect, test } from 'bun:test';

import {
  ConfiguredSqsFaultInjection,
  DisabledSqsFaultInjection,
  SqsInjectedCrashError,
} from '../../src/modules/messaging/sqs/application/ports/sqs-fault-injection.port';

const originalEnabled = process.env.SQS_TEST_FAULT_ENABLED;
const originalPoint = process.env.SQS_TEST_FAULT_POINT;

afterEach(() => {
  if (originalEnabled === undefined) delete process.env.SQS_TEST_FAULT_ENABLED;
  else process.env.SQS_TEST_FAULT_ENABLED = originalEnabled;
  if (originalPoint === undefined) delete process.env.SQS_TEST_FAULT_POINT;
  else process.env.SQS_TEST_FAULT_POINT = originalPoint;
});

describe('SQS fault injection', () => {
  test('is disabled by default', async () => {
    delete process.env.SQS_TEST_FAULT_ENABLED;
    delete process.env.SQS_TEST_FAULT_POINT;

    await expect(new DisabledSqsFaultInjection().checkpoint('BEFORE_COMMIT')).resolves.toBeUndefined();
    await expect(new ConfiguredSqsFaultInjection().checkpoint('AFTER_COMMIT_BEFORE_ACK')).resolves.toBeUndefined();
  });

  test('throws only for the explicitly configured test checkpoint', async () => {
    process.env.SQS_TEST_FAULT_ENABLED = 'true';
    process.env.SQS_TEST_FAULT_POINT = 'AFTER_COMMIT_BEFORE_ACK';
    const injection = new ConfiguredSqsFaultInjection();

    await expect(injection.checkpoint('BEFORE_COMMIT')).resolves.toBeUndefined();
    await expect(injection.checkpoint('AFTER_COMMIT_BEFORE_ACK')).rejects.toBeInstanceOf(SqsInjectedCrashError);
  });
});

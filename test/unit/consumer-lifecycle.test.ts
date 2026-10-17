import { describe, expect, test } from 'bun:test';

import { ConsumerLifecycle } from '../../src/modules/messaging/sqs/application/consumer-lifecycle';

describe('ConsumerLifecycle', () => {
  test('stops receiving new messages while draining in-flight work', () => {
    const lifecycle = new ConsumerLifecycle();

    expect(lifecycle.beginMessage()).toBe(true);
    lifecycle.requestShutdown();

    expect(lifecycle.canReceive()).toBe(false);
    expect(lifecycle.snapshot()).toEqual({ state: 'DRAINING', inFlight: 1 });
    expect(lifecycle.beginMessage()).toBe(false);

    lifecycle.completeMessage();
    expect(lifecycle.snapshot()).toEqual({ state: 'STOPPED', inFlight: 0 });
  });

  test('stops immediately when shutdown starts without in-flight work', () => {
    const lifecycle = new ConsumerLifecycle();

    lifecycle.requestShutdown();

    expect(lifecycle.snapshot()).toEqual({ state: 'STOPPED', inFlight: 0 });
    expect(() => lifecycle.completeMessage()).toThrow('none is in flight');
  });
});

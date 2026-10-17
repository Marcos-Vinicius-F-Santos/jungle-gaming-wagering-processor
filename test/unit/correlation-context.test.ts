import { describe, expect, test } from 'bun:test';
import { validate as isUuid, version as uuidVersion } from 'uuid';

import { AsyncLocalCorrelationContext } from '../../src/shared/infrastructure/correlation/async-local-correlation-context';

describe('AsyncLocalCorrelationContext', () => {
  test('keeps safe values and replaces invalid values with UUIDv7', () => {
    const context = new AsyncLocalCorrelationContext();

    expect(context.resolve('request-123')).toBe('request-123');
    expect(isUuid(context.resolve())).toBe(true);
    expect(uuidVersion(context.resolve())).toBe(7);
    expect(uuidVersion(context.resolve(''))).toBe(7);
    expect(uuidVersion(context.resolve('x'.repeat(101)))).toBe(7);
    expect(uuidVersion(context.resolve('request\n123'))).toBe(7);
  });

  test('isolates concurrent asynchronous callbacks', async () => {
    const context = new AsyncLocalCorrelationContext();

    const values = await Promise.all([
      context.run('correlation-a', async () => {
        await delay(5);
        return context.current();
      }),
      context.run('correlation-b', async () => {
        await delay(1);
        return context.current();
      }),
    ]);

    expect(values).toEqual(['correlation-a', 'correlation-b']);
    expect(context.current()).toBeUndefined();
  });
});

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

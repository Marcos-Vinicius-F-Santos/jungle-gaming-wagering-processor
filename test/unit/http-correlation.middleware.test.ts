import { describe, expect, test } from 'bun:test';
import { validate as isUuid, version as uuidVersion } from 'uuid';

import { AsyncLocalCorrelationContext } from '../../src/shared/infrastructure/correlation/async-local-correlation-context';
import {
  CORRELATION_HEADER,
  HttpCorrelationMiddleware,
} from '../../src/shared/infrastructure/correlation/http-correlation.middleware';

describe('HttpCorrelationMiddleware', () => {
  test('echoes a valid correlation header and exposes it in the async context', () => {
    const context = new AsyncLocalCorrelationContext();
    const middleware = new HttpCorrelationMiddleware(context);
    const responseHeaders = new Map<string, string>();
    let observedCorrelationId: string | undefined;

    middleware.use(
      { headers: { [CORRELATION_HEADER]: 'request-123' } } as never,
      { setHeader: (name: string, value: string) => responseHeaders.set(name, value) } as never,
      () => { observedCorrelationId = context.current(); },
    );

    expect(responseHeaders.get(CORRELATION_HEADER)).toBe('request-123');
    expect(observedCorrelationId).toBe('request-123');
  });

  test('generates UUIDv7 for an invalid header', () => {
    const context = new AsyncLocalCorrelationContext();
    const middleware = new HttpCorrelationMiddleware(context);
    const responseHeaders = new Map<string, string>();

    middleware.use(
      { headers: { [CORRELATION_HEADER]: 'x'.repeat(101) } } as never,
      { setHeader: (name: string, value: string) => responseHeaders.set(name, value) } as never,
      () => undefined,
    );

    const generated = responseHeaders.get(CORRELATION_HEADER) ?? '';
    expect(isUuid(generated)).toBe(true);
    expect(uuidVersion(generated)).toBe(7);
  });
});

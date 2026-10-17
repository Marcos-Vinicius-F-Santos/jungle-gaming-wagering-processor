import { describe, expect, test } from 'bun:test';

import type { LogContext } from '../../src/shared/application/ports/logger.port';
import { sanitizeLogContext } from '../../src/shared/infrastructure/logging/sanitize-log-context';
import { StructuredLogger } from '../../src/shared/infrastructure/logging/structured-logger';
import { AsyncLocalCorrelationContext } from '../../src/shared/infrastructure/correlation/async-local-correlation-context';

describe('StructuredLogger', () => {
  test('removes sensitive and raw payload fields and handles circular values', () => {
    const circular: Record<string, unknown> = { safe: 'value' };
    circular.self = circular;

    const context = sanitizeLogContext({
      correlationId: 'corr-123',
      password: 'do-not-log',
      receiptHandle: 'do-not-log',
      payload: { amount: '100.00' },
      amount: '100.00',
      error: new Error('database failed\nwith details'),
      circular,
    });

    expect(context.correlationId).toBe('corr-123');
    expect(context.password).toBeUndefined();
    expect(context.receiptHandle).toBeUndefined();
    expect(context.payload).toBeUndefined();
    expect(context.amount).toBeUndefined();
    expect(context.error).toEqual({ name: 'Error', message: 'database failed with details' });
    expect(context.circular).toEqual({ safe: 'value', self: '[Circular]' });
  });

  test('emits one valid JSON line with stable envelope fields', () => {
    const correlationContext = new AsyncLocalCorrelationContext();
    const logger = new StructuredLogger(correlationContext);
    const lines: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => lines.push(String(args[0]));

    try {
      logger.info('health.check.completed', {
        correlationId: 'corr-123',
        payload: { secret: 'do-not-log' },
      } satisfies LogContext);
    } finally {
      console.log = originalLog;
    }

    const parsed = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
    expect(parsed.level).toBe('info');
    expect(parsed.event).toBe('health.check.completed');
    expect(typeof parsed.timestamp).toBe('string');
    expect(parsed.correlationId).toBe('corr-123');
    expect(parsed.payload).toBeUndefined();
  });

  test('adds the active correlation id when the caller omits it', () => {
    const correlationContext = new AsyncLocalCorrelationContext();
    const logger = new StructuredLogger(correlationContext);
    const lines: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => lines.push(String(args[0]));

    try {
      correlationContext.run('context-123', () => logger.info('wager.processed'));
    } finally {
      console.log = originalLog;
    }

    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({ correlationId: 'context-123' });
  });
});

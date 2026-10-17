import { Inject, Injectable, Optional } from '@nestjs/common';

import { CORRELATION_CONTEXT } from '../../application/ports/correlation-context.port';
import type { CorrelationContext } from '../../application/ports/correlation-context.port';
import type { AppLogger, LogContext } from '../../application/ports/logger.port';
import { sanitizeLogContext } from './sanitize-log-context';

@Injectable()
export class StructuredLogger implements AppLogger {
  constructor(
    @Optional() @Inject(CORRELATION_CONTEXT) private readonly correlationContext?: CorrelationContext,
  ) {}

  info(event: string, context: LogContext = {}): void {
    this.write('info', event, context);
  }

  warn(event: string, context: LogContext = {}): void {
    this.write('warn', event, context);
  }

  error(event: string, context: LogContext = {}): void {
    this.write('error', event, context);
  }

  private write(level: string, event: string, context: LogContext): void {
    const correlationId = this.correlationContext?.current();
    console.log(JSON.stringify({
      level,
      event,
      timestamp: new Date().toISOString(),
      ...sanitizeLogContext({
        ...(correlationId && context.correlationId === undefined ? { correlationId } : {}),
        ...context,
      }),
    }));
  }
}

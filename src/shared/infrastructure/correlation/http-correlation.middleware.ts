import { Inject, Injectable, type NestMiddleware } from '@nestjs/common';

import { CORRELATION_CONTEXT } from '../../application/ports/correlation-context.port';
import type { CorrelationContext } from '../../application/ports/correlation-context.port';

export const CORRELATION_HEADER = 'x-correlation-id';

interface HttpRequest {
  headers: Record<string, string | string[] | undefined>;
}

interface HttpResponse {
  setHeader(name: string, value: string): void;
}

type NextFunction = (error?: unknown) => void;

@Injectable()
export class HttpCorrelationMiddleware implements NestMiddleware {
  constructor(
    @Inject(CORRELATION_CONTEXT) private readonly correlationContext: CorrelationContext,
  ) {}

  use(request: HttpRequest, response: HttpResponse, next: NextFunction): void {
    const header = request.headers[CORRELATION_HEADER];
    const requestedCorrelationId = Array.isArray(header) ? header[0] : header;
    const correlationId = this.correlationContext.resolve(
      typeof requestedCorrelationId === 'string' ? requestedCorrelationId : undefined,
    );

    response.setHeader(CORRELATION_HEADER, correlationId);
    this.correlationContext.run(correlationId, () => next());
  }
}

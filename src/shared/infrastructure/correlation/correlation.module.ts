import { Global, Module } from '@nestjs/common';

import { CORRELATION_CONTEXT } from '../../application/ports/correlation-context.port';
import { AsyncLocalCorrelationContext } from './async-local-correlation-context';
import { HttpCorrelationMiddleware } from './http-correlation.middleware';

@Global()
@Module({
  providers: [
    AsyncLocalCorrelationContext,
    { provide: CORRELATION_CONTEXT, useExisting: AsyncLocalCorrelationContext },
    HttpCorrelationMiddleware,
  ],
  exports: [CORRELATION_CONTEXT, AsyncLocalCorrelationContext, HttpCorrelationMiddleware],
})
export class CorrelationModule {}

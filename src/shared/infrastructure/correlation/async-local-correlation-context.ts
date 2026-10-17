import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';
import { v7 as uuidv7 } from 'uuid';

import type { CorrelationContext } from '../../application/ports/correlation-context.port';

const MAX_CORRELATION_ID_LENGTH = 100;

@Injectable()
export class AsyncLocalCorrelationContext implements CorrelationContext {
  private readonly storage = new AsyncLocalStorage<string>();

  current(): string | undefined {
    return this.storage.getStore();
  }

  resolve(value?: string): string {
    const normalized = value?.trim();
    if (!normalized || normalized.length > MAX_CORRELATION_ID_LENGTH || hasControlCharacter(normalized)) {
      return uuidv7();
    }
    return normalized;
  }

  run<T>(correlationId: string, callback: () => T): T {
    return this.storage.run(this.resolve(correlationId), callback);
  }
}

function hasControlCharacter(value: string): boolean {
  return /[\u0000-\u001f\u007f]/u.test(value);
}

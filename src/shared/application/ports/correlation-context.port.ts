export interface CorrelationContext {
  current(): string | undefined;
  resolve(value?: string): string;
  run<T>(correlationId: string, callback: () => T): T;
}

export const CORRELATION_CONTEXT = Symbol('CORRELATION_CONTEXT');

export type LogContext = Readonly<Record<string, unknown>>;

export interface AppLogger {
  info(event: string, context?: LogContext): void;
  warn(event: string, context?: LogContext): void;
  error(event: string, context?: LogContext): void;
}

export const LOGGER = Symbol('LOGGER');

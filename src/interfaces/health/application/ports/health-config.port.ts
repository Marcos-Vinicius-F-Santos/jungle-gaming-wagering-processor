export interface HealthConfig {
  dependencyTimeoutMs: number;
  totalTimeoutMs: number;
}

export const HEALTH_CONFIG = Symbol('HEALTH_CONFIG');

export const DEFAULT_HEALTH_CONFIG: HealthConfig = {
  dependencyTimeoutMs: 500,
  totalTimeoutMs: 1_000,
};

export function readHealthConfig(env: NodeJS.ProcessEnv = process.env): HealthConfig {
  const dependencyTimeoutMs = readInteger(
    env.HEALTH_DEPENDENCY_TIMEOUT_MS,
    DEFAULT_HEALTH_CONFIG.dependencyTimeoutMs,
    50,
    5_000,
    'HEALTH_DEPENDENCY_TIMEOUT_MS',
  );
  const totalTimeoutMs = readInteger(
    env.HEALTH_TOTAL_TIMEOUT_MS,
    DEFAULT_HEALTH_CONFIG.totalTimeoutMs,
    100,
    15_000,
    'HEALTH_TOTAL_TIMEOUT_MS',
  );

  if (totalTimeoutMs < dependencyTimeoutMs) {
    throw new Error('HEALTH_TOTAL_TIMEOUT_MS must be greater than or equal to HEALTH_DEPENDENCY_TIMEOUT_MS');
  }

  return { dependencyTimeoutMs, totalTimeoutMs };
}

function readInteger(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
  name: string,
): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

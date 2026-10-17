import { describe, expect, test } from 'bun:test';

import {
  DEFAULT_HEALTH_CONFIG,
  readHealthConfig,
} from '../../src/interfaces/health/application/ports/health-config.port';

describe('readHealthConfig', () => {
  test('uses safe defaults without exposing infrastructure credentials', () => {
    expect(readHealthConfig({})).toEqual(DEFAULT_HEALTH_CONFIG);
  });

  test('accepts operational overrides', () => {
    expect(readHealthConfig({
      HEALTH_DEPENDENCY_TIMEOUT_MS: '750',
      HEALTH_TOTAL_TIMEOUT_MS: '2500',
    })).toEqual({ dependencyTimeoutMs: 750, totalTimeoutMs: 2500 });
  });

  test('rejects invalid bounds and an inconsistent deadline', () => {
    expect(() => readHealthConfig({ HEALTH_DEPENDENCY_TIMEOUT_MS: '49' })).toThrow();
    expect(() => readHealthConfig({ HEALTH_TOTAL_TIMEOUT_MS: '15001' })).toThrow();
    expect(() => readHealthConfig({
      HEALTH_DEPENDENCY_TIMEOUT_MS: '900',
      HEALTH_TOTAL_TIMEOUT_MS: '800',
    })).toThrow();
  });
});

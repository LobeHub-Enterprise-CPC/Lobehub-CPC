import { afterEach, describe, expect, it, vi } from 'vitest';

import { getServerDBConfig } from './db';

const LIMITS = [
  'DB_DISCOVERY_LOOKUP_POOL_MAX',
  'DB_DISCOVERY_PLATFORM_POOL_MAX',
  'DB_PLATFORM_POOL_MAX',
  'DB_TENANT_POOL_IDLE_TIMEOUT_MS',
  'DB_TENANT_POOL_MAX_CONNECTIONS',
  'DB_TENANT_POOL_MAX_POOLS',
] as const;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('database pool limits', () => {
  it('default to the limits the pools had before they were configurable', () => {
    for (const name of LIMITS) vi.stubEnv(name, undefined);
    expect(getServerDBConfig()).toMatchObject({
      DB_DISCOVERY_LOOKUP_POOL_MAX: 2,
      DB_DISCOVERY_PLATFORM_POOL_MAX: 4,
      DB_PLATFORM_POOL_MAX: 10,
      DB_TENANT_POOL_IDLE_TIMEOUT_MS: 300_000,
      DB_TENANT_POOL_MAX_CONNECTIONS: 4,
      DB_TENANT_POOL_MAX_POOLS: 32,
    });
  });

  it('reads a configured limit', () => {
    vi.stubEnv('DB_TENANT_POOL_MAX_POOLS', '64');
    expect(getServerDBConfig().DB_TENANT_POOL_MAX_POOLS).toBe(64);
  });

  it.each(LIMITS.flatMap((name) => ['0', '-1', '1.5', 'abc', ''].map((value) => [name, value])))(
    'refuses %s=%j',
    (name, value) => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      vi.stubEnv(name, value);
      expect(() => getServerDBConfig()).toThrow();
    },
  );
});

// @vitest-environment node
import type { Pool, PoolConfig } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import { TenantPoolManager } from './pool';

const connection = { database: 'db', host: 'h', password: 'p', port: 5432, user: 'u' };
const config = (n: number) => ({
  connection: { ...connection, user: `u${n}` },
  connectionVersion: 1,
  purpose: 'request' as const,
  schemaName: `tenant_${n.toString(16).padStart(24, '0')}`,
  tenantId: `tenant-${n}`,
});

/** Pools whose `end()` resolves only when the test says so, like a real socket close. */
const manager = (maxPools: number) => {
  const closers: (() => void)[] = [];
  const created: PoolConfig[] = [];
  const instance = new TenantPoolManager({
    createPool: (poolConfig) => {
      created.push(poolConfig);
      return {
        end: () => new Promise<void>((resolve) => closers.push(resolve)),
        on: vi.fn(),
      } as unknown as Pool;
    },
    maxPools,
  });
  return { closers, created, instance };
};

describe('TenantPoolManager capacity', () => {
  it('evicts an idle pool to make room instead of refusing the cold tenant', () => {
    const { instance } = manager(2);
    instance.acquire(config(1)).release();
    instance.acquire(config(2)).release();

    // Both pools are idle: the third tenant takes the room of the least recently used one, even
    // though the evicted pool is still closing.
    const lease = instance.acquire(config(3));
    expect(lease.pool).toBeDefined();
    lease.release();
  });

  it('refuses a cold tenant only when every pool is in use', () => {
    const { instance } = manager(2);
    instance.acquire(config(1));
    instance.acquire(config(2));
    expect(() => instance.acquire(config(3))).toThrow(/capacity/);
  });

  it('bounds the pools that are still closing', () => {
    const { closers, instance } = manager(1);
    // Each acquire evicts the previous idle pool, whose close never completes.
    instance.acquire(config(1)).release();
    instance.acquire(config(2)).release();
    expect(() => instance.acquire(config(3))).toThrow(/capacity/);
    for (const close of closers) close();
  });

  it('frees the capacity of a pool once it has closed', async () => {
    const { closers, instance } = manager(1);
    instance.acquire(config(1)).release();
    instance.acquire(config(2)).release();
    closers[0]();
    await Promise.resolve();
    await Promise.resolve();
    expect(instance.acquire(config(3)).pool).toBeDefined();
  });
});

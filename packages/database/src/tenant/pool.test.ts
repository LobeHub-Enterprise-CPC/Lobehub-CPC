// @vitest-environment node
import { EventEmitter } from 'node:events';

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

describe('TenantPoolManager connection identity and limits', () => {
  it('names every tenant connection and keeps the default limits', () => {
    const { created, instance } = manager(32);
    instance.acquire(config(1)).release();
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      application_name: expect.stringMatching(/^tw-[\w.-]+\/[\w.-]+\/\d+\/tenant(\/|$)/),
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 30_000,
      max: 4,
    });
    // The name is the process and the pool, never the tenant.
    expect(created[0].application_name).not.toContain('tenant-1');
    expect(created[0].application_name).not.toContain(config(1).schemaName);
    expect(Buffer.byteLength(created[0].application_name!)).toBeLessThanOrEqual(63);
  });

  it('passes configured limits to the pools', () => {
    const created: PoolConfig[] = [];
    const instance = new TenantPoolManager({
      createPool: (poolConfig) => {
        created.push(poolConfig);
        return { end: async () => {}, on: vi.fn() } as unknown as Pool;
      },
      maxConnectionsPerPool: 2,
    });
    instance.acquire(config(1)).release();
    expect(created[0].max).toBe(2);
  });
});

describe('TenantPoolManager stats', () => {
  it('aggregates over tenants: active and closing pools, totals and borrowed peak', () => {
    const closers: (() => void)[] = [];
    const pools: (EventEmitter & {
      idleCount: number;
      totalCount: number;
      waitingCount: number;
    })[] = [];
    const instance = new TenantPoolManager({
      createPool: () => {
        const pool = Object.assign(new EventEmitter(), {
          end: () => new Promise<void>((resolve) => closers.push(resolve)),
          idleCount: 1,
          totalCount: 2,
          waitingCount: 0,
        });
        pools.push(pool);
        return pool as unknown as Pool;
      },
    });
    const first = instance.acquire(config(1));
    const second = instance.acquire(config(2));
    pools[0].emit('connect');
    pools[0].emit('acquire');
    pools[1].emit('acquire');
    pools[1].emit('release');
    // Tenant 1 moves to a new connection version: its old pool drains, then closes.
    first.release();
    instance.acquire({ ...config(1), connectionVersion: 2 }).release();

    const stats = instance.stats();
    expect(stats).toMatchObject({
      activePools: 2,
      borrowed: 1,
      closingPools: 1,
      connects: 1,
      maxBorrowed: 2,
      maxBorrowedPerPool: 1,
      pools: 3,
      tenants: 2,
      total: 6,
    });
    expect(JSON.stringify(stats)).not.toMatch(/tenant-\d|tenant_/);
    second.release();
    for (const close of closers) close();
  });
});

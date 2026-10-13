import { describe, expect, it, vi } from 'vitest';

import { TenantEndpointsService } from '@/server/services/tenantControlPlane/endpoints';

import { EndpointRoutingCache, invalidateEndpointRouting } from '../endpointCache';

describe('endpoint routing snapshots', () => {
  it('does not retry when a read ages out while returning to its caller', async () => {
    const times = [0, 4999, 5000];
    const load = vi.fn(async () => ({ version: 1 }));
    const cache = new EndpointRoutingCache(load, () => times.shift() ?? 5000);
    await expect(cache.get('a')).rejects.toMatchObject({ code: 'TENANT_UNAVAILABLE' });
    expect(load).toHaveBeenCalledTimes(1);
  });
  it('replaces an expired pending key and never lets its old result refill the new key', async () => {
    let now = 0;
    let oldResolve!: (value: { version: number }) => void;
    const load = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            oldResolve = resolve;
          }),
      )
      .mockResolvedValue({ version: 2 });
    const cache = new EndpointRoutingCache(load, () => now);
    const oldRead = cache.get('a');
    const oldRejection = expect(oldRead).rejects.toMatchObject({ code: 'TENANT_UNAVAILABLE' });
    now = 5000;
    expect(await cache.get('a')).toEqual({ version: 2 });
    await oldRejection;
    oldResolve({ version: 1 });
    await Promise.resolve();
    expect(await cache.get('a')).toEqual({ version: 2 });
    expect(load).toHaveBeenCalledTimes(2);
  });
  it('does not renew an older tenant snapshot when another slug or host references it', async () => {
    let now = 0;
    // The loader resolves through this cache only after construction.
    // eslint-disable-next-line prefer-const
    let cache: EndpointRoutingCache<{ version: number; startedAt: number }>;
    const load = vi.fn(
      async (key: string): Promise<{ version: number; startedAt: number } | null> => {
        if (key !== 'tenant:a') return cache.get('tenant:a');
        return { version: load.mock.calls.length, startedAt: now };
      },
    );
    cache = new EndpointRoutingCache(
      load,
      () => now,
      (entry) => entry.startedAt,
    );
    expect((await cache.get('tenant:a'))?.version).toBe(1);
    now = 4999;
    expect((await cache.get('slug:a'))?.version).toBe(1);
    expect((await cache.get('host:a'))?.version).toBe(1);
    now = 5000;
    expect((await cache.get('slug:a'))?.version).toBe(5);
    expect((await cache.get('host:a'))?.version).toBe(5);
  });
  it('counts a slow successful read from its start, not its completion', async () => {
    let now = 0;
    const load = vi.fn(async () => {
      now += 4000;
      return { version: load.mock.calls.length };
    });
    const cache = new EndpointRoutingCache(load, () => now);
    expect(await cache.get('a')).toEqual({ version: 1 });
    now = 4999;
    expect(await cache.get('a')).toEqual({ version: 1 });
    now = 5000;
    expect(await cache.get('a')).toEqual({ version: 2 });
  });
  it('invalidates only after receive commits, never on rollback', async () => {
    const load = vi.fn(async () => ({ version: 0 }));
    const cache = new EndpointRoutingCache(load);
    await cache.get('slug:a');
    let commit!: (value: unknown) => void;
    const db = {
      transaction: vi.fn(
        () =>
          new Promise((resolve) => {
            commit = resolve;
          }),
      ),
    };
    const service = new TenantEndpointsService(db as never);
    const input = {
      tenantId: 'a',
      eventId: 'event-1',
      version: 1,
      endpoints: [{ id: 'default' as const, kind: 'default' as const, host: null, active: true }],
    };
    const receiving = service.receive(input);
    await cache.get('slug:a');
    expect(load).toHaveBeenCalledTimes(1);
    commit({ appliedVersion: 1 });
    await receiving;
    await cache.get('slug:a');
    expect(load).toHaveBeenCalledTimes(2);
    db.transaction.mockRejectedValueOnce(new Error('rollback'));
    await expect(service.receive(input)).rejects.toThrow('rollback');
    await cache.get('slug:a');
    expect(load).toHaveBeenCalledTimes(2);
  });
  it('coalesces a key and refreshes at five seconds, including negative lookups', async () => {
    let now = 0;
    const load = vi.fn(async (key: string) => (key === 'unknown' ? null : { version: 0 }));
    const cache = new EndpointRoutingCache(load, () => now);
    expect(await Promise.all([cache.get('a'), cache.get('a')])).toEqual([
      { version: 0 },
      { version: 0 },
    ]);
    expect(load).toHaveBeenCalledTimes(1);
    now = 4999;
    await cache.get('a');
    expect(load).toHaveBeenCalledTimes(1);
    now = 5000;
    await cache.get('a');
    await Promise.all([cache.get('unknown'), cache.get('unknown')]);
    expect(load).toHaveBeenCalledTimes(3);
    for (let i = 0; i < 1100; i++) await cache.get(`unknown-${i}`);
    expect(cache.size).toBeLessThanOrEqual(1000);
  });
  it('does not cache failures or reuse expired state during a database outage', async () => {
    let now = 0;
    const load = vi
      .fn()
      .mockResolvedValueOnce({ version: 1 })
      .mockRejectedValueOnce(new Error('PG'))
      .mockResolvedValue({ version: 2 });
    const cache = new EndpointRoutingCache(load, () => now);
    await cache.get('a');
    now = 5000;
    await expect(cache.get('a')).rejects.toMatchObject({ code: 'TENANT_UNAVAILABLE' });
    expect(await cache.get('a')).toEqual({ version: 2 });
  });
  it('invalidates all authority and tenant keys and rejects an old pending read', async () => {
    let resolve!: (value: unknown) => void;
    const load = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      )
      .mockResolvedValue({ version: 2 });
    const cache = new EndpointRoutingCache(load);
    const pending = cache.get('tenant:a');
    const rejection = expect(pending).rejects.toMatchObject({ code: 'TENANT_UNAVAILABLE' });
    invalidateEndpointRouting();
    resolve({ version: 1 });
    await rejection;
    expect(await cache.get('tenant:a')).toEqual({ version: 2 });
    await cache.get('slug:a');
    await cache.get('host:old.example.com');
    await cache.get('host:new.example.com');
    invalidateEndpointRouting();
    await cache.get('slug:a');
    await cache.get('host:old.example.com');
    await cache.get('host:new.example.com');
    expect(load).toHaveBeenCalledTimes(8);
  });
  it('fails closed on reads that exceed the propagation bound', async () => {
    let now = 0;
    const cache = new EndpointRoutingCache(
      async () => {
        now = 5000;
        return { version: 1 };
      },
      () => now,
    );
    await expect(cache.get('a')).rejects.toMatchObject({ code: 'TENANT_UNAVAILABLE' });
  });
});

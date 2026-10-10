// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { RedisRuntimeConfigProvider } from './RedisRuntimeConfigProvider';

const { getRedisConfigMock, initializeRedisMock, initializeSharedRedisMock, scope } = vi.hoisted(
  () => ({
    getRedisConfigMock: vi.fn(),
    initializeRedisMock: vi.fn(),
    initializeSharedRedisMock: vi.fn(),
    scope: { current: { slug: 'acme', tenantId: 'tenant-1' } as any },
  }),
);

// Tenant snapshots are read in the tenant of the request (`scope.current`).
vi.mock('@lobechat/database/tenant', () => ({
  currentTenantScope: () => scope.current ?? undefined,
  requireTenantScope: () => {
    if (!scope.current) throw new Error('TENANT_REQUIRED');
    return scope.current;
  },
}));

vi.mock('@/envs/redis', () => ({
  getRedisConfig: getRedisConfigMock,
}));

vi.mock('@/libs/redis', () => ({
  initializeRedis: initializeRedisMock,
  initializeSharedRedis: initializeSharedRedisMock,
}));

const testDomain = {
  cacheTtlMs: 5000,
  getStorageKey: () => 'runtime-config:test:published',
  key: 'test',
  schema: z.object({ enabled: z.boolean() }),
};

describe('RedisRuntimeConfigProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    scope.current = { slug: 'acme', tenantId: 'tenant-1' };
  });

  it('caches tenant snapshots per tenant', async () => {
    getRedisConfigMock.mockReturnValue({ enabled: true });
    const getMock = vi
      .fn()
      .mockResolvedValueOnce(JSON.stringify({ enabled: true }))
      .mockResolvedValueOnce(JSON.stringify({ enabled: false }));
    initializeRedisMock.mockResolvedValue({ get: getMock });

    const provider = new RedisRuntimeConfigProvider(testDomain);
    const first = await provider.getSnapshot();
    scope.current = { slug: 'other', tenantId: 'tenant-2' };
    const second = await provider.getSnapshot();

    expect(first?.data).toEqual({ enabled: true });
    expect(second?.data).toEqual({ enabled: false });
    expect(getMock).toHaveBeenCalledTimes(2);
  });

  it('reads no tenant snapshot outside a tenant', async () => {
    getRedisConfigMock.mockReturnValue({ enabled: true });
    scope.current = null;

    const provider = new RedisRuntimeConfigProvider(testDomain);

    await expect(provider.getSnapshot()).resolves.toBeNull();
    expect(initializeRedisMock).not.toHaveBeenCalled();
  });

  it('reads a shared domain from the shared keyspace, also outside a tenant', async () => {
    getRedisConfigMock.mockReturnValue({ enabled: true });
    scope.current = null;
    initializeSharedRedisMock.mockResolvedValue({
      get: vi.fn().mockResolvedValue(JSON.stringify({ enabled: true })),
    });

    const provider = new RedisRuntimeConfigProvider({ ...testDomain, shared: true });

    await expect(provider.getSnapshot()).resolves.toMatchObject({ data: { enabled: true } });
    expect(initializeRedisMock).not.toHaveBeenCalled();
  });

  it('should return parsed snapshot data from versioned envelope', async () => {
    getRedisConfigMock.mockReturnValue({ enabled: true });
    initializeRedisMock.mockResolvedValue({
      get: vi.fn().mockResolvedValue(
        JSON.stringify({
          data: { enabled: true },
          updatedAt: '2026-04-23T00:00:00.000Z',
          version: 12,
        }),
      ),
    });

    const provider = new RedisRuntimeConfigProvider(testDomain);
    const snapshot = await provider.getSnapshot({ scope: 'global' });

    expect(snapshot).toEqual({
      data: { enabled: true },
      updatedAt: '2026-04-23T00:00:00.000Z',
      version: 12,
    });
  });

  it('should return null when redis is disabled', async () => {
    getRedisConfigMock.mockReturnValue({ enabled: false });

    const provider = new RedisRuntimeConfigProvider(testDomain);

    expect(provider.isEnabled()).toBe(false);
  });

  it('should treat cached null snapshots as cache hits', async () => {
    const getMock = vi.fn().mockResolvedValue(null);

    getRedisConfigMock.mockReturnValue({ enabled: true });
    initializeRedisMock.mockResolvedValue({ get: getMock });

    const provider = new RedisRuntimeConfigProvider(testDomain);

    await expect(provider.getSnapshot({ scope: 'global' })).resolves.toBeNull();
    await expect(provider.getSnapshot({ scope: 'global' })).resolves.toBeNull();

    expect(initializeRedisMock).toHaveBeenCalledTimes(1);
    expect(getMock).toHaveBeenCalledTimes(1);
  });

  it('should re-read missing snapshots when null caching is disabled', async () => {
    const getMock = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(
        JSON.stringify({
          data: { enabled: true },
          updatedAt: '2026-07-22T00:00:00.000Z',
          version: 1,
        }),
      );

    getRedisConfigMock.mockReturnValue({ enabled: true });
    initializeRedisMock.mockResolvedValue({ get: getMock });

    const provider = new RedisRuntimeConfigProvider({
      ...testDomain,
      cacheNullSnapshots: false,
    });

    await expect(provider.getSnapshot({ id: 'user-1', scope: 'user' })).resolves.toBeNull();
    await expect(provider.getSnapshot({ id: 'user-1', scope: 'user' })).resolves.toEqual({
      data: { enabled: true },
      updatedAt: '2026-07-22T00:00:00.000Z',
      version: 1,
    });

    expect(initializeRedisMock).toHaveBeenCalledTimes(2);
    expect(getMock).toHaveBeenCalledTimes(2);
  });

  it('should proactively evict expired selector cache entries', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-23T00:00:00.000Z'));

    const getMock = vi.fn().mockResolvedValue(null);

    getRedisConfigMock.mockReturnValue({ enabled: true });
    initializeRedisMock.mockResolvedValue({ get: getMock });

    const provider = new RedisRuntimeConfigProvider(testDomain);

    await expect(provider.getSnapshot({ id: 'user-1', scope: 'user' })).resolves.toBeNull();
    expect((provider as any).cache.size).toBe(1);

    vi.setSystemTime(new Date('2026-04-23T00:00:06.000Z'));

    await expect(provider.getSnapshot({ id: 'user-2', scope: 'user' })).resolves.toBeNull();

    expect((provider as any).cache.has('tenant-1:user:user-1')).toBe(false);
    expect((provider as any).cache.has('tenant-1:user:user-2')).toBe(true);
    expect((provider as any).cache.size).toBe(1);
    expect(getMock).toHaveBeenCalledTimes(2);
  });
});

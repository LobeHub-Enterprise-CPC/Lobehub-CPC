// @vitest-environment node
import { EventEmitter } from 'node:events';

import type { TenantScope } from '@lobechat/database/tenant';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

class FakeRedis extends EventEmitter {
  disconnect = vi.fn();
  psubscribe = vi.fn(async () => 1);
  publish = vi.fn(async () => 1);
}

const connections = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('ioredis', () => ({
  default: function Redis(...args: unknown[]) {
    return connections.create(...args);
  },
}));

let inTenant: <T>(tenantId: string, operation: () => Promise<T>) => Promise<T>;

/**
 * The publisher is a process singleton; every test starts from a fresh module, and enters
 * tenants through the tenant scope instance that module sees.
 */
const load = async () => {
  vi.resetModules();
  const { runWithTenantScope } = await import('@lobechat/database/tenant');
  inTenant = (tenantId, operation) => runWithTenantScope({ tenantId } as TenantScope, operation);
  return (await import('./channelWake')).channelWake;
};

// The first import transforms the whole server module graph.
beforeAll(() => load(), 60_000);

beforeEach(() => {
  vi.clearAllMocks();
  connections.create.mockReset();
  vi.unstubAllEnvs();
  vi.stubEnv('REDIS_URL', 'redis://redis:6379');
  vi.stubEnv('REDIS_PREFIX', 'tw');
});

describe('Channel worker wake', () => {
  it('publishes the current tenant on its tenant-scoped channel, and the worker receives it', async () => {
    const subscriber = new FakeRedis();
    const publisher = new FakeRedis();
    connections.create.mockReturnValueOnce(subscriber).mockReturnValueOnce(publisher);
    const channelWake = await load();

    const woken: string[] = [];
    const close = channelWake.subscribe((tenantId) => woken.push(tenantId));
    subscriber.emit('ready');
    expect(subscriber.psubscribe).toHaveBeenCalledWith('tw:t:*:channel:wake');

    await inTenant('org:a', () => channelWake.wake());
    expect(publisher.publish).toHaveBeenCalledWith(
      'tw:t:org%3Aa:channel:wake',
      JSON.stringify({ tenantId: 'org:a' }),
    );
    subscriber.emit('pmessage', 'tw:t:*:channel:wake', 'tw:t:org%3Aa:channel:wake', '{}');
    // Another deployment sharing the Redis server.
    subscriber.emit('pmessage', 'tw:t:*:channel:wake', 'other:t:org-b:channel:wake', '{}');
    expect(woken).toEqual(['org:a']);

    close?.();
    expect(subscriber.disconnect).toHaveBeenCalled();
  });

  it('subscribes again after Redis reconnects', async () => {
    const subscriber = new FakeRedis();
    subscriber.psubscribe.mockRejectedValueOnce(new Error('connection lost'));
    connections.create.mockReturnValueOnce(subscriber);
    const channelWake = await load();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    channelWake.subscribe(() => {});
    subscriber.emit('ready');
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    subscriber.emit('ready');
    expect(subscriber.psubscribe).toHaveBeenCalledTimes(2);
  });

  it('never fails the caller when publishing fails', async () => {
    const publisher = new FakeRedis();
    publisher.publish.mockRejectedValue(new Error('Redis unavailable'));
    connections.create.mockReturnValue(publisher);
    const channelWake = await load();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(inTenant('t-a', () => channelWake.wake())).resolves.toBeUndefined();

    connections.create.mockImplementation(() => {
      throw new Error('bad Redis URL');
    });
    const reloaded = await load();
    await expect(inTenant('t-a', () => reloaded.wake())).resolves.toBeUndefined();
  });

  it('does nothing outside a tenant', async () => {
    const channelWake = await load();
    await channelWake.wake();
    expect(connections.create).not.toHaveBeenCalled();
  });

  it('opens no connection when Redis is not configured', async () => {
    vi.stubEnv('REDIS_URL', '');
    const channelWake = await load();
    await expect(inTenant('t-a', () => channelWake.wake())).resolves.toBeUndefined();
    expect(channelWake.subscribe(() => {})).toBeUndefined();
    expect(connections.create).not.toHaveBeenCalled();
  });
});

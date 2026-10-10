// @vitest-environment node
import { runWithTenantScope, type TenantScope } from '@lobechat/database/tenant';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { instances } = vi.hoisted(() => ({ instances: [] as any[] }));

vi.mock('ioredis', () => {
  class FakeRedis {
    options: any;
    store = new Map<string, string>();
    constructor(_url: string, options: any) {
      this.options = options;
      instances.push(this);
    }
    on() {
      return this;
    }
    async get(key: string) {
      return this.store.get(`${this.options.keyPrefix}${key}`) ?? null;
    }
    async set(key: string, value: string) {
      this.store.set(`${this.options.keyPrefix}${key}`, value);
      return 'OK';
    }
    async keys(pattern: string) {
      const prefix = pattern.replace(/\*$/, '');
      return [...this.store.keys()].filter((key) => key.startsWith(prefix));
    }
    async quit() {}
  }
  return { default: FakeRedis };
});

vi.mock('@/envs/redis', () => ({ redisEnv: { REDIS_URL: 'redis://localhost:6379' } }));

const inTenant = <T>(tenantId: string, fn: () => T) =>
  runWithTenantScope({ session: {}, slug: tenantId, tenantId } as unknown as TenantScope, fn);

describe('agent runtime Redis client', () => {
  afterEach(async () => {
    const { closeAgentRuntimeRedisClient } = await import('../redis');
    await closeAgentRuntimeRedisClient();
    instances.length = 0;
  });

  it('keeps each tenant in its own keyspace, also through a held client', async () => {
    const { getAgentRuntimeRedisClient } = await import('../redis');

    const held = inTenant('tenant-1', () => getAgentRuntimeRedisClient())!;
    await inTenant('tenant-1', () => held.set('agent_runtime_state:op-1', 'one'));
    await inTenant('tenant-2', () => held.set('agent_runtime_state:op-1', 'two'));

    expect(instances.map((instance) => instance.options.keyPrefix)).toEqual([
      't:tenant-1:',
      't:tenant-2:',
    ]);
    await expect(inTenant('tenant-1', () => held.get('agent_runtime_state:op-1'))).resolves.toBe(
      'one',
    );
    await expect(inTenant('tenant-1', () => held.keys('agent_runtime_state:*'))).resolves.toEqual([
      'agent_runtime_state:op-1',
    ]);
  });

  it('fails closed outside a tenant', async () => {
    const { getAgentRuntimeRedisClient, isAgentRuntimeRedisEnabled } = await import('../redis');

    expect(isAgentRuntimeRedisEnabled()).toBe(true);
    expect(() => getAgentRuntimeRedisClient()).toThrow(/TENANT_REQUIRED/);
  });
});

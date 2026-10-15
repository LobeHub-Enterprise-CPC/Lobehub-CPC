// @vitest-environment node
import { runWithTenantScope, type TenantScope } from '@lobechat/database/tenant';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { instances, mockRedisEnv } = vi.hoisted(() => ({
  instances: [] as any[],
  mockRedisEnv: {} as Record<string, unknown>,
}));

vi.mock('ioredis', () => {
  class FakeRedis {
    options: any;
    store = new Map<string, string>();
    url: string;
    constructor(url: string, options: any) {
      this.url = url;
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

vi.mock('@/envs/redis', () => ({ redisEnv: mockRedisEnv }));

const inTenant = <T>(tenantId: string, fn: () => T) =>
  runWithTenantScope({ session: {}, slug: tenantId, tenantId } as unknown as TenantScope, fn);

describe('agent runtime Redis client', () => {
  beforeEach(() => {
    for (const key of Object.keys(mockRedisEnv)) delete mockRedisEnv[key];
    mockRedisEnv.REDIS_URL = 'redis://localhost:6379';
  });

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

  describe('connection settings from the shared Redis env', () => {
    it('passes username, password, database and TLS to ioredis', async () => {
      Object.assign(mockRedisEnv, {
        REDIS_DATABASE: 3,
        REDIS_PASSWORD: 'secret',
        REDIS_TLS: true,
        REDIS_USERNAME: 'agent',
      });
      const { createAgentRuntimeRedisClient } = await import('../redis');

      createAgentRuntimeRedisClient(undefined, { keyPrefix: 't:tenant-1:' });

      expect(instances[0].url).toBe('redis://localhost:6379');
      expect(instances[0].options).toMatchObject({
        db: 3,
        keyPrefix: 't:tenant-1:',
        password: 'secret',
        tls: {},
        username: 'agent',
      });
    });

    it('leaves the options unset when the env does not configure them', async () => {
      const { createAgentRuntimeRedisClient } = await import('../redis');

      createAgentRuntimeRedisClient();

      expect(instances[0].options.password).toBeUndefined();
      expect(instances[0].options.username).toBeUndefined();
      expect(instances[0].options.db).toBeUndefined();
      expect(instances[0].options.tls).toBeUndefined();
    });

    it('does not send the env credentials to an explicitly passed URL', async () => {
      mockRedisEnv.REDIS_PASSWORD = 'secret';
      const { createAgentRuntimeRedisClient } = await import('../redis');

      createAgentRuntimeRedisClient('redis://other:6379');

      expect(instances[0].url).toBe('redis://other:6379');
      expect(instances[0].options.password).toBeUndefined();
    });
  });
});

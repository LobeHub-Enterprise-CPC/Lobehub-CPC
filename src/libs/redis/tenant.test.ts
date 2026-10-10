// @vitest-environment node
import { runWithTenantScope, type TenantScope } from '@lobechat/database/tenant';
import { describe, expect, it, vi } from 'vitest';

import { currentTenantRedisPrefix, PrefixedRedisClient, sharedRedisPrefix } from './tenant';
import { type BaseRedisProvider } from './types';

const inTenant = <T>(tenantId: string, fn: () => T) =>
  runWithTenantScope({ session: {}, slug: tenantId, tenantId } as unknown as TenantScope, fn);

const createBase = () =>
  ({
    del: vi.fn().mockResolvedValue(1),
    eval: vi.fn().mockResolvedValue(1),
    get: vi.fn().mockResolvedValue('v'),
    mset: vi.fn().mockResolvedValue('OK'),
    scan: vi.fn().mockResolvedValue(['0', ['t:tenant-1:a', 't:tenant-1:b']]),
    set: vi.fn().mockResolvedValue('OK'),
  }) as unknown as BaseRedisProvider;

describe('tenant Redis keyspace', () => {
  it('confines every key to the current tenant', async () => {
    const base = createBase();
    const client = new PrefixedRedisClient(base, currentTenantRedisPrefix);

    await inTenant('tenant-1', () => client.get('file:x'));
    await inTenant('tenant-2', () => client.set('file:x', 'v', { ex: 10 }));
    await inTenant('tenant-1', () => client.del('a', 'b'));
    await inTenant('tenant-1', () => client.mset({ a: 1 }));

    expect(base.get).toHaveBeenCalledWith('t:tenant-1:file:x');
    expect(base.set).toHaveBeenCalledWith('t:tenant-2:file:x', 'v', { ex: 10 });
    expect(base.del).toHaveBeenCalledWith('t:tenant-1:a', 't:tenant-1:b');
    expect(base.mset).toHaveBeenCalledWith({ 't:tenant-1:a': 1 });
  });

  it('prefixes only the key arguments of a script', async () => {
    const base = createBase();
    const client = new PrefixedRedisClient(base, currentTenantRedisPrefix);

    await inTenant('tenant-1', () => client.eval('return 1', 1, 'lock', 'token'));

    expect(base.eval).toHaveBeenCalledWith('return 1', 1, 't:tenant-1:lock', 'token');
  });

  it('scans only the tenant keyspace and returns logical keys', async () => {
    const base = createBase();
    const client = new PrefixedRedisClient(base, currentTenantRedisPrefix);

    const result = await inTenant('tenant-1', () => client.scan('0', 'MATCH', 'run:*'));

    expect(base.scan).toHaveBeenCalledWith('0', 'MATCH', 't:tenant-1:run:*');
    expect(result).toEqual(['0', ['a', 'b']]);
  });

  it('fails closed outside a tenant', () => {
    const client = new PrefixedRedisClient(createBase(), currentTenantRedisPrefix);

    expect(() => client.get('x')).toThrow(/TENANT_REQUIRED/);
  });

  it('keeps deployment data under the shared keyspace', async () => {
    const base = createBase();
    const client = new PrefixedRedisClient(base, sharedRedisPrefix);

    await client.get('runtime-config:feature-flags:published');

    expect(base.get).toHaveBeenCalledWith('t:_shared:runtime-config:feature-flags:published');
  });
});

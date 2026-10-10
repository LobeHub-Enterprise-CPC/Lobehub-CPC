// @vitest-environment node
import { runWithTenantScope, type TenantScope } from '@lobechat/database/tenant';
import { describe, expect, it, vi } from 'vitest';

import {
  buildTenantCallbackUrl,
  tenantCallbackPath,
  tenantPublicBaseUrl,
  withTenantRequestUrl,
} from '../callbackUrl';

// tests/setup.ts mocks this module for every other test.
vi.unmock('../callbackUrl');

vi.mock('@/envs/app', () => ({
  getAppOriginUrl: () => 'https://app.example.com',
  getInternalApiUrl: () => 'http://lobehub:3210',
}));

const scope = { session: {}, slug: 'acme', tenantId: 'tenant-1' } as unknown as TenantScope;
const inTenant = <T>(fn: () => T) => runWithTenantScope(scope, fn);

describe('tenant callback addresses', () => {
  it('addresses a callback to the current tenant over the internal base', () => {
    expect(inTenant(() => buildTenantCallbackUrl('/api/workflows/goal/advance'))).toBe(
      'http://lobehub:3210/t/acme/api/workflows/goal/advance',
    );
  });

  it('keeps an explicit base and does not double the prefix', () => {
    expect(
      inTenant(() => buildTenantCallbackUrl('/t/acme/api/agent', 'https://proxy.example.com/')),
    ).toBe('https://proxy.example.com/t/acme/api/agent');
    expect(inTenant(() => tenantCallbackPath('api/agent/run'))).toBe('/t/acme/api/agent/run');
  });

  it('gives the tenant public base for external callers', () => {
    expect(inTenant(() => tenantPublicBaseUrl())).toBe('https://app.example.com/t/acme');
  });

  it('fails closed outside a tenant', () => {
    expect(() => buildTenantCallbackUrl('/api/workflows/goal/advance')).toThrow();
    expect(() => tenantCallbackPath('/trpc/async')).toThrow();
  });

  it('restores the tenant address of a routed workflow request', async () => {
    const routed = new Request('http://lobehub:3210/api/workflows/goal/advance?x=1', {
      body: JSON.stringify({ a: 1 }),
      headers: { 'upstash-signature': 'sig' },
      method: 'POST',
    });
    const restored = inTenant(() => withTenantRequestUrl(routed));
    expect(restored.url).toBe('http://lobehub:3210/t/acme/api/workflows/goal/advance?x=1');
    expect(restored.headers.get('upstash-signature')).toBe('sig');
    await expect(restored.json()).resolves.toEqual({ a: 1 });

    const already = new Request('http://lobehub:3210/t/acme/api/workflows/x', { method: 'POST' });
    expect(inTenant(() => withTenantRequestUrl(already))).toBe(already);
  });
});

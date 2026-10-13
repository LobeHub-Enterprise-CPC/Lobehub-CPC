// @vitest-environment node
import { runWithTenantScope, type TenantScope } from '@lobechat/database/tenant';
import { describe, expect, it, vi } from 'vitest';

import {
  buildTenantCallbackUrl,
  buildTenantPublicUrl,
  tenantCallbackPath,
  tenantPublicBaseUrl,
  withTenantPublicRequestUrl,
  withTenantRequestUrl,
} from '../callbackUrl';

// tests/setup.ts mocks this module for every other test.
vi.unmock('../callbackUrl');

vi.mock('@/envs/app', () => ({
  getAppOriginUrl: () => 'https://app.example.com',
  getInternalApiUrl: () => 'http://lobehub:3210',
}));

const scope = {
  endpoint: { basePath: '/t/acme', publicUrl: 'https://app.example.com/t/acme', version: 1 },
  session: {},
  slug: 'acme',
  tenantId: 'tenant-1',
} as unknown as TenantScope;
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

describe('canonical public URLs', () => {
  it('uses custom root for business links and protocol request reconstruction', () => {
    const custom = {
      ...scope,
      endpoint: { basePath: '', publicUrl: 'https://chat.example.com', version: 2 },
    };
    runWithTenantScope(custom, () => {
      expect(buildTenantPublicUrl('/t/acme/agent?topic=1')).toBe(
        'https://chat.example.com/agent?topic=1',
      );
      expect(withTenantPublicRequestUrl(new Request('http://internal/oidc/token?x=1')).url).toBe(
        'https://chat.example.com/oidc/token?x=1',
      );
      expect(buildTenantCallbackUrl('/api/workflows/run')).toBe(
        'http://lobehub:3210/t/acme/api/workflows/run',
      );
    });
  });
  it.each([
    '/t/beta/agent',
    '/../../t/beta',
    '/a/%2e%2e/t/beta',
    '/a/%2fbeta',
    '/a/%5cbeta',
    '/a/../b',
    '//evil.example.com',
    '/t/%61cme/agent',
  ])('rejects ambiguous or cross-tenant public path %s', (path) => {
    expect(() => inTenant(() => buildTenantPublicUrl(path))).toThrow();
  });
});

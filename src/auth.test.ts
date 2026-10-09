import type * as TenantModule from '@lobechat/database/tenant';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as TenantSso from '@/server/services/tenantSso';

const mocks = vi.hoisted(() => ({
  defineConfig: vi.fn((config: unknown) => ({ api: {}, config, handler: vi.fn() })),
  loadTenantSsoProviders: vi.fn(async () => []),
  scope: null as null | { session: { database: object }; slug: string; tenantId: string },
}));

vi.mock('@/libs/better-auth/define-config', () => ({
  defineConfig: mocks.defineConfig,
  tenantAuthBasePath: (slug: string) => `/t/${slug}/api/auth`,
}));

vi.mock('@/server/services/tenantSso', async (importOriginal) => ({
  ...(await importOriginal<typeof TenantSso>()),
  loadTenantSsoProviders: mocks.loadTenantSsoProviders,
}));

vi.mock('@lobechat/database/tenant', async (importOriginal) => ({
  ...(await importOriginal<typeof TenantModule>()),
  requireTenantScope: () => {
    if (!mocks.scope) throw new Error('TENANT_REQUIRED');
    return mocks.scope;
  },
}));

vi.unmock('@/auth');

const { getTenantAuth, invalidateTenantAuth, tenantCookiePrefix } = await import('./auth');

describe('auth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.scope = null;
    invalidateTenantAuth('tenant-a');
    invalidateTenantAuth('tenant-b');
  });

  it('refuses to build an auth instance outside a tenant', async () => {
    await expect(getTenantAuth()).rejects.toThrow('TENANT_REQUIRED');
  });

  it('builds one instance per tenant, keyed and cookied by the tenant id', async () => {
    const database = {};
    mocks.scope = { session: { database }, slug: 'acme', tenantId: 'tenant-a' };
    const first = await getTenantAuth();
    expect(await getTenantAuth()).toBe(first);

    mocks.scope = { session: { database }, slug: 'beta', tenantId: 'tenant-b' };
    const second = await getTenantAuth();
    expect(second).not.toBe(first);

    expect(mocks.defineConfig).toHaveBeenCalledTimes(2);
    expect(mocks.defineConfig).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        cookiePrefix: tenantCookiePrefix('tenant-a'),
        database,
        secondaryStorageNamespace: 't:tenant-a',
        tenant: { id: 'tenant-a', slug: 'acme' },
      }),
    );
    expect(tenantCookiePrefix('tenant-a')).toMatch(/^lh_[\da-f]{24}$/);
    expect(tenantCookiePrefix('tenant-a')).not.toBe(tenantCookiePrefix('tenant-b'));
  });
});

import type * as TenantModule from '@lobechat/database/tenant';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as TenantSso from '@/server/services/tenantSso';

const defaultLoginMethods = {
  emailPassword: true,
  magicLink: false,
  requireEmailVerification: false,
};

const mocks = vi.hoisted(() => ({
  defineConfig: vi.fn((config: unknown) => ({ api: {}, config, handler: vi.fn() })),
  /** Each tenant's saved login methods; unset tenants use the defaults. */
  loginMethods: {} as Record<string, typeof defaultLoginMethods>,
  loadTenantSsoProviders: vi.fn(async () => []),
  scope: null as null | {
    endpoint: { basePath: string; publicUrl: string; version: number };
    session: { database: object };
    slug: string;
    tenantId: string;
  },
}));

vi.mock('@/libs/better-auth/define-config', () => ({
  defineConfig: mocks.defineConfig,
}));

vi.mock('@/server/globalConfig/loginMethods', () => ({
  getLoginMethods: async () => mocks.loginMethods[mocks.scope!.tenantId] ?? defaultLoginMethods,
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
    mocks.loginMethods = {};
    invalidateTenantAuth('tenant-a');
    invalidateTenantAuth('tenant-b');
  });

  it('refuses to build an auth instance outside a tenant', async () => {
    await expect(getTenantAuth()).rejects.toThrow('TENANT_REQUIRED');
  });

  it('builds one instance per tenant, keyed and cookied by the tenant id', async () => {
    const database = {};
    mocks.scope = {
      endpoint: { basePath: '/t/acme', publicUrl: 'https://app.example/t/acme', version: 1 },
      session: { database },
      slug: 'acme',
      tenantId: 'tenant-a',
    };
    const first = await getTenantAuth();
    expect(await getTenantAuth()).toBe(first);

    mocks.scope = {
      endpoint: { basePath: '/t/beta', publicUrl: 'https://app.example/t/beta', version: 1 },
      session: { database },
      slug: 'beta',
      tenantId: 'tenant-b',
    };
    const second = await getTenantAuth();
    expect(second).not.toBe(first);

    expect(mocks.defineConfig).toHaveBeenCalledTimes(2);
    expect(mocks.defineConfig).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        cookiePrefix: tenantCookiePrefix('tenant-a'),
        database,
        secondaryStorageNamespace: 't:tenant-a',
        tenant: {
          endpoint: { basePath: '/t/acme', publicUrl: 'https://app.example/t/acme', version: 1 },
          id: 'tenant-a',
          slug: 'acme',
        },
      }),
    );
    expect(tenantCookiePrefix('tenant-a')).toMatch(/^lh_[\da-f]{24}$/);
    expect(tenantCookiePrefix('tenant-a')).not.toBe(tenantCookiePrefix('tenant-b'));
  });

  it('rebuilds the instance when the runtime replaces the tenant database session', async () => {
    // A datasource update yields a new session; the old one's pool is retired.
    mocks.scope = {
      endpoint: { basePath: '/t/acme', publicUrl: 'https://app.example/t/acme', version: 1 },
      session: { database: {} },
      slug: 'acme',
      tenantId: 'tenant-a',
    };
    const stale = await getTenantAuth();

    const database = {};
    mocks.scope = {
      endpoint: { basePath: '/t/acme', publicUrl: 'https://app.example/t/acme', version: 1 },
      session: { database },
      slug: 'acme',
      tenantId: 'tenant-a',
    };
    const current = await getTenantAuth();

    expect(current).not.toBe(stale);
    expect(mocks.defineConfig).toHaveBeenLastCalledWith(expect.objectContaining({ database }));
    expect(await getTenantAuth()).toBe(current);
  });

  it("rebuilds only that tenant's instance when its login methods change", async () => {
    const scopeOf = (tenantId: string, slug: string) => ({
      endpoint: { basePath: `/t/${slug}`, publicUrl: `https://app.example/t/${slug}`, version: 1 },
      session: { database: {} },
      slug,
      tenantId,
    });
    const scopeA = scopeOf('tenant-a', 'acme');
    const scopeB = scopeOf('tenant-b', 'beta');
    mocks.scope = scopeA;
    const a = await getTenantAuth();
    mocks.scope = scopeB;
    const b = await getTenantAuth();

    const changed = { emailPassword: false, magicLink: true, requireEmailVerification: true };
    mocks.loginMethods['tenant-a'] = changed;
    mocks.scope = scopeA;
    const rebuilt = await getTenantAuth();

    expect(rebuilt).not.toBe(a);
    expect(mocks.defineConfig).toHaveBeenLastCalledWith(
      expect.objectContaining({ loginMethods: changed }),
    );
    mocks.scope = scopeB;
    expect(await getTenantAuth()).toBe(b);
    expect(mocks.defineConfig).toHaveBeenCalledTimes(3);
  });

  it('bounds the cached SSO snapshots like the instances', async () => {
    const database = {};
    const scopeOf = (n: number) => ({
      endpoint: { basePath: `/t/t${n}`, publicUrl: `https://app.example/t/t${n}`, version: 1 },
      session: { database },
      slug: `t${n}`,
      tenantId: `bounded-${n}`,
    });
    for (let n = 0; n < 70; n++) {
      mocks.scope = scopeOf(n);
      await getTenantAuth();
    }
    expect(mocks.loadTenantSsoProviders).toHaveBeenCalledTimes(70);

    // The newest tenants are still cached; the oldest was evicted and is read again.
    mocks.scope = scopeOf(69);
    await getTenantAuth();
    expect(mocks.loadTenantSsoProviders).toHaveBeenCalledTimes(70);
    mocks.scope = scopeOf(0);
    await getTenantAuth();
    expect(mocks.loadTenantSsoProviders).toHaveBeenCalledTimes(71);
    for (let n = 0; n < 70; n++) invalidateTenantAuth(`bounded-${n}`);
  });
});

// @vitest-environment node
import { runWithTenantScope, type TenantScope } from '@lobechat/database/tenant';
import { describe, expect, it, vi } from 'vitest';

import { createOIDCProvider } from '@/libs/oidc-provider/provider';

import { getOIDCProvider } from './oidcProvider';

vi.mock('@/envs/auth', () => ({ authEnv: { ENABLE_OIDC: true } }));
vi.mock('@/database/core/db-adaptor', () => ({ serverDB: {} }));
vi.mock('@/libs/oidc-provider/provider', () => ({
  createOIDCProvider: vi.fn(async (_db, { endpoint, tenantId }) => ({ endpoint, tenantId })),
}));

const entryOf = (slug: string) => ({
  basePath: `/t/${slug}`,
  publicUrl: `https://app.example.com/t/${slug}`,
  version: 1,
});

const inTenant = (slug: string) =>
  runWithTenantScope(
    { endpoint: entryOf(slug), slug, tenantId: `tenant-${slug}` } as TenantScope,
    getOIDCProvider,
  );

describe('tenant OIDC instances', () => {
  it('reuses a tenant instance without sharing its issuer configuration with another tenant', async () => {
    const [a, again, b] = await Promise.all([inTenant('acme'), inTenant('acme'), inTenant('beta')]);
    expect(a).toBe(again);
    expect(a).not.toBe(b);
    expect(a).toMatchObject({ endpoint: entryOf('acme') });
    expect(b).toMatchObject({ endpoint: entryOf('beta') });
    // Each instance stamps its own tenant id on the access tokens it issues.
    expect(a).toMatchObject({ tenantId: 'tenant-acme' });
    expect(b).toMatchObject({ tenantId: 'tenant-beta' });
    expect(createOIDCProvider).toHaveBeenCalledTimes(2);
  });

  it('refuses initialization outside a tenant scope', async () => {
    await expect(getOIDCProvider()).rejects.toMatchObject({ code: 'TENANT_REQUIRED' });
  });
});

it('rebuilds a tenant provider when the active endpoint revision changes', async () => {
  const scope = {
    slug: 'acme',
    tenantId: 'endpoint-cache-tenant',
    endpoint: { basePath: '/t/acme', publicUrl: 'https://app.example.com/t/acme', version: 1 },
  } as TenantScope;
  const first = await runWithTenantScope(scope, getOIDCProvider);
  const next = {
    ...scope,
    endpoint: { basePath: '', publicUrl: 'https://chat.example.com', version: 2 },
  };
  const changed = await runWithTenantScope(next, getOIDCProvider);
  expect(first).not.toBe(changed);
  expect(await runWithTenantScope(next, getOIDCProvider)).toBe(changed);
  expect(createOIDCProvider).toHaveBeenLastCalledWith(expect.anything(), {
    endpoint: next.endpoint,
    slug: scope.slug,
    tenantId: scope.tenantId,
  });
});

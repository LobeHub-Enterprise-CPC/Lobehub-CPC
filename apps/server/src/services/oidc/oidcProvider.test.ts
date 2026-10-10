// @vitest-environment node
import { runWithTenantScope, type TenantScope } from '@lobechat/database/tenant';
import { describe, expect, it, vi } from 'vitest';

import { createOIDCProvider } from '@/libs/oidc-provider/provider';

import { getOIDCProvider } from './oidcProvider';

vi.mock('@/envs/auth', () => ({ authEnv: { ENABLE_OIDC: true } }));
vi.mock('@/database/core/db-adaptor', () => ({ serverDB: {} }));
vi.mock('@/libs/oidc-provider/provider', () => ({
  createOIDCProvider: vi.fn(async (_db, slug) => ({ slug })),
}));

const inTenant = (slug: string) =>
  runWithTenantScope({ slug, tenantId: `tenant-${slug}` } as TenantScope, getOIDCProvider);

describe('tenant OIDC instances', () => {
  it('reuses a tenant instance without sharing its issuer configuration with another tenant', async () => {
    const [a, again, b] = await Promise.all([inTenant('acme'), inTenant('acme'), inTenant('beta')]);
    expect(a).toBe(again);
    expect(a).not.toBe(b);
    expect(a).toMatchObject({ slug: 'acme' });
    expect(b).toMatchObject({ slug: 'beta' });
    expect(createOIDCProvider).toHaveBeenCalledTimes(2);
  });

  it('refuses initialization outside a tenant scope', async () => {
    await expect(getOIDCProvider()).rejects.toMatchObject({ code: 'TENANT_REQUIRED' });
  });
});

// @vitest-environment node
import type * as TenantModule from '@lobechat/database/tenant';
import type { SsoProviderItem } from '@lobechat/database/tenant/schemas';
import type { ssrfSafeFetch } from '@lobechat/ssrf-safe-fetch';
import type { GenericOAuthConfig } from 'better-auth/plugins';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { sealTenantData } from '@/server/crypto/tenantKeys';
import { ssoSecretAad } from '@/server/services/tenantSso';

const mocks = vi.hoisted(() => ({
  defineConfig: vi.fn((config: { genericOAuthProviders: GenericOAuthConfig[] }) => ({
    api: {},
    config,
    handler: vi.fn(),
  })),
  fetch: vi.fn<typeof ssrfSafeFetch>(),
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
vi.mock('@lobechat/ssrf-safe-fetch', () => ({ ssrfSafeFetch: mocks.fetch }));
vi.mock('@lobechat/database/tenant', async (importOriginal) => ({
  ...(await importOriginal<typeof TenantModule>()),
  requireTenantScope: () => mocks.scope,
}));
vi.unmock('@/auth');
const { getTenantAuth, invalidateTenantAuth } = await import('./auth');

const endpoints = {
  authorization_endpoint: 'https://recovery.example.com/authorize',
  token_endpoint: 'https://recovery.example.com/token',
  userinfo_endpoint: 'https://recovery.example.com/userinfo',
};
let sequence = 0;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-12T12:00:00Z'));
  vi.stubEnv('KEY_VAULTS_SECRET', 'auth-discovery-test-secret');
  vi.clearAllMocks();
  mocks.fetch.mockReset();
  invalidateTenantAuth('tenant-discovery');
  const row: SsoProviderItem = {
    admissionPolicy: 'allowlist',
    createdAt: new Date(),
    deletedAt: null,
    displayName: 'Recovery IdP',
    enabled: true,
    id: 'sso-recovery',
    issuer: `https://recovery.example.com/${++sequence}`,
    logoUrl: null,
    oauth2Config: null,
    oidcConfig: { clientId: 'client-1' },
    protocol: 'oidc',
    providerId: 'recovery-idp',
    revision: 1,
    samlConfig: null,
    secretConfigEncrypted: sealTenantData(
      'tenant-discovery',
      JSON.stringify({ clientSecret: 'secret-1' }),
      ssoSecretAad('tenant-discovery', 'recovery-idp', 1),
    ),
    updatedAt: new Date(),
  };
  const query = { from: () => query, orderBy: async () => [row], where: () => query };
  mocks.scope = {
    endpoint: { basePath: '/t/acme', publicUrl: 'https://app.example/t/acme', version: 1 },
    session: { database: { select: () => query } },
    slug: 'acme',
    tenantId: 'tenant-discovery',
  };
});

afterEach(() => {
  invalidateTenantAuth('tenant-discovery');
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

const latestProvider = () => mocks.defineConfig.mock.calls.at(-1)![0].genericOAuthProviders[0];

describe('tenant auth discovery validity', () => {
  it('rebuilds a usable instance after discovery recovers without a provider revision change', async () => {
    mocks.fetch.mockRejectedValue(new Error('IdP temporarily unavailable'));
    const failed = await getTenantAuth();
    await expect(
      latestProvider().getToken!({ code: 'code', redirectURI: 'https://app.example.com/callback' }),
    ).rejects.toThrow('SSO token endpoint is not available');

    vi.setSystemTime(Date.now() + 60_001);
    mocks.fetch.mockResolvedValue(Response.json(endpoints));
    const recovered = await getTenantAuth();
    expect(recovered).not.toBe(failed);
    expect(await getTenantAuth()).toBe(recovered);

    mocks.fetch.mockResolvedValue(
      Response.json({ access_token: 'recovered-token', token_type: 'Bearer' }),
    );
    expect(
      await latestProvider().getToken!({
        code: 'code',
        redirectURI: 'https://app.example.com/callback',
      }),
    ).toMatchObject({ accessToken: 'recovered-token' });
    expect(mocks.fetch.mock.calls.at(-1)![0]).toBe(endpoints.token_endpoint);
  });

  it('rebuilds when discovery endpoints change after expiry at the same provider revision', async () => {
    mocks.fetch.mockResolvedValue(Response.json(endpoints));
    const first = await getTenantAuth();
    vi.setSystemTime(Date.now() + 300_001);
    mocks.fetch.mockResolvedValue(
      Response.json({ ...endpoints, token_endpoint: 'https://recovery.example.com/new-token' }),
    );
    expect(await getTenantAuth()).not.toBe(first);
    expect(latestProvider().tokenUrl).toBe('https://recovery.example.com/new-token');
  });
});

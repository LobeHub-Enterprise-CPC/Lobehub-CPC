// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TenantGateError } from '@/server/modules/Tenant/errors';

import { GET } from './route';

const mocks = vi.hoisted(() => ({
  business: { managed: true },
  getTenantSsoProviders: vi.fn(),
  list: vi.fn(),
}));

vi.mock('@lobechat/business-auth', () => ({
  listBusinessSSOProviders: mocks.list,
  get managedBusinessSSO() {
    return mocks.business.managed;
  },
}));

vi.mock('@/auth', () => ({ getTenantSsoProviders: mocks.getTenantSsoProviders }));

// The tenant provider as `getTenantSsoProviders` returns it: with its secrets and endpoints.
const tenantProvider = (overrides: Record<string, unknown> = {}) => ({
  admissionPolicy: 'allowlist',
  config: { clientId: 'client-1' },
  displayName: 'Clerk',
  generic: true,
  issuer: 'https://idp.example.com',
  logoUrl: 'https://img.clerk.com/logo.png',
  protocol: 'oidc',
  providerId: 'clerk',
  revision: 2,
  secrets: { clientSecret: 's3cret' },
  ...overrides,
});

describe('/webapi/auth/sso-providers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.business.managed = true;
    mocks.list.mockResolvedValue([]);
    mocks.getTenantSsoProviders.mockResolvedValue([]);
  });

  it('answers a tenant refusal raised while listing providers with its code', async () => {
    mocks.list.mockRejectedValueOnce(
      new Error('Failed query', { cause: new TenantGateError('TENANT_EXPIRED') }),
    );

    const response = await GET();

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ code: 'TENANT_EXPIRED' });
  });

  it('keeps other failures as an unavailable configuration', async () => {
    mocks.list.mockRejectedValueOnce(new Error('boom'));

    const response = await GET();

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ code: 'SSO_CONFIGURATION_UNAVAILABLE' });
  });

  describe("the tenant's own providers", () => {
    beforeEach(() => {
      mocks.business.managed = false;
    });

    it('lists their display name and logo, and nothing else about them', async () => {
      mocks.getTenantSsoProviders.mockResolvedValueOnce([
        tenantProvider(),
        tenantProvider({
          displayName: 'GitHub',
          logoUrl: null,
          protocol: 'oauth2',
          providerId: 'github',
        }),
      ]);

      const response = await GET();
      const body = await response.json();

      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(body).toEqual({
        managed: false,
        providers: [
          {
            displayName: 'Clerk',
            id: 'clerk',
            logoUrl: 'https://img.clerk.com/logo.png',
            protocol: 'oidc',
          },
          { displayName: 'GitHub', id: 'github', logoUrl: null, protocol: 'oauth2' },
        ],
      });
      expect(JSON.stringify(body)).not.toMatch(/s3cret|client-1|idp\.example\.com/);
    });

    it('drops a logo the sign-in page cannot load', async () => {
      mocks.getTenantSsoProviders.mockResolvedValueOnce([
        tenantProvider({ logoUrl: 'javascript:alert(1)' }),
      ]);

      const body = await (await GET()).json();

      expect(body.providers[0].logoUrl).toBeNull();
    });

    it('keeps a distribution bridge provider next to them, without repeating an id', async () => {
      mocks.list.mockResolvedValueOnce([
        { displayName: 'Bridge', id: 'bridge-1', logoUrl: null, protocol: 'bridge' },
        { displayName: 'Dup', id: 'clerk', logoUrl: null, protocol: 'bridge' },
      ]);
      mocks.getTenantSsoProviders.mockResolvedValueOnce([tenantProvider()]);

      const body = await (await GET()).json();

      expect(body.providers.map((item: { id: string }) => item.id)).toEqual(['clerk', 'bridge-1']);
      expect(body.providers[0].displayName).toBe('Clerk');
    });
  });

  it('leaves the list to the distribution when it manages sign-in itself', async () => {
    mocks.getTenantSsoProviders.mockResolvedValueOnce([tenantProvider()]);
    mocks.list.mockResolvedValueOnce([
      { displayName: 'Company', id: 'managed-id', logoUrl: null, protocol: 'oidc' },
    ]);

    const body = await (await GET()).json();

    expect(body.managed).toBe(true);
    expect(body.providers.map((item: { id: string }) => item.id)).toEqual(['managed-id']);
    expect(mocks.getTenantSsoProviders).not.toHaveBeenCalled();
  });
});

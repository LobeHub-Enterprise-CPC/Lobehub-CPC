/**
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { expectNoSecretsLogged, startLogCapture, stopLogCapture } from './__tests__/logCapture';
import { DESKTOP_CLIENT_ID } from './desktopClient';
import { createOIDCProvider } from './provider';

const NAME = 'SENTINEL_TENANT_NAME_c0ffee';
const SLUG = 'sentinel-tenant-slug-c0ffee';

const state = vi.hoisted(() => ({
  config: undefined as any,
  findSlugEndpoint: vi.fn(),
  hasOtherOrganizations: vi.fn(),
  findUser: vi.fn(),
}));

vi.mock('debug', async () => (await import('./__tests__/logCapture')).debugMock);
vi.mock('@lobechat/business-auth', () => ({
  assertBusinessUserAccess: vi.fn(),
  isBusinessAuthorizationError: () => false,
}));
vi.mock('oidc-provider', () => ({
  default: class {
    constructor(_issuer: string, config: unknown) {
      state.config = config;
    }
    on() {}
  },
  errors: {},
}));
vi.mock('@/server/modules/Tenant/endpoints', () => ({
  findSlugEndpoint: state.findSlugEndpoint,
}));
vi.mock('@/server/services/tenantDiscovery/otherOrganizations', () => ({
  hasOtherOrganizations: state.hasOtherOrganizations,
}));
vi.mock('@/database/models/user', () => ({ UserModel: { findById: state.findUser } }));
vi.mock('@/envs/app', () => ({ appEnv: { APP_URL: 'http://localhost:3000' } }));
vi.mock('@/libs/oidc-provider/jwt', () => ({ getJWKS: () => ({ keys: [] }) }));
vi.mock('@/locales/resources', () => ({ normalizeLocale: (locale: string) => locale }));
vi.mock('./adapter', () => ({ DrizzleAdapter: { createAdapterFactory: () => class {} } }));
vi.mock('./config', () => ({ defaultClaims: {}, defaultClients: [], defaultScopes: ['openid'] }));
vi.mock('./cookies', () => ({ getOIDCCookieKeys: () => ['test-secret'] }));
vi.mock('./interaction-policy', () => ({ createInteractionPolicy: () => [] }));

const scope = {
  endpoint: { basePath: '/t/acme', publicUrl: 'http://localhost:3000/t/acme', version: 1 },
  slug: 'acme',
  tenantId: 'tenant-acme',
};

const claimsFor = async (use: string, clientId = DESKTOP_CLIENT_ID) => {
  const account = await state.config.findAccount({ oidc: { client: { clientId } } }, 'alice');
  return account.claims(use, 'openid profile email');
};

describe('organization display claims', () => {
  beforeEach(async () => {
    startLogCapture();
    state.findUser.mockResolvedValue({ email: 'a@example.com', id: 'alice', username: 'alice' });
    state.findSlugEndpoint.mockResolvedValue({ name: NAME, slug: SLUG, tenantId: 'tenant-acme' });
    state.hasOtherOrganizations.mockResolvedValue(true);
    await createOIDCProvider({} as never, scope);
  });

  afterEach(() => {
    stopLogCapture();
  });

  it('adds the organization name and slug to the id_token only', async () => {
    expect(await claimsFor('id_token')).toMatchObject({ tenant_name: NAME, tenant_slug: SLUG });

    const userinfo = await claimsFor('userinfo');
    expect(userinfo).not.toHaveProperty('tenant_name');
    expect(userinfo).not.toHaveProperty('tenant_slug');
  });

  it('looks the organization up by the slug of the provider scope', async () => {
    await claimsFor('id_token');

    expect(state.findSlugEndpoint).toHaveBeenCalledWith('acme');
  });

  it('does not take the display values from another tenant', async () => {
    state.findSlugEndpoint.mockResolvedValue({ name: NAME, slug: SLUG, tenantId: 'tenant-other' });

    const claims = await claimsFor('id_token');

    expect(claims).not.toHaveProperty('tenant_name');
    expect(claims).not.toHaveProperty('tenant_slug');
  });

  it('omits the claims, without failing the issuance, when the directory lookup fails', async () => {
    state.findSlugEndpoint.mockRejectedValue(new Error(`directory down ${NAME}`));

    const claims = await claimsFor('id_token');

    expect(claims).toMatchObject({ sub: 'alice', email: 'a@example.com' });
    expect(claims).not.toHaveProperty('tenant_name');
    expect(claims).not.toHaveProperty('tenant_slug');
    expectNoSecretsLogged([NAME]);
  });

  it('omits the claims for an organization without a directory entry', async () => {
    state.findSlugEndpoint.mockResolvedValue(null);

    expect(await claimsFor('id_token')).not.toHaveProperty('tenant_name');
  });

  it('keeps the values out of the logs', async () => {
    await claimsFor('id_token');
    await claimsFor('userinfo');

    expectNoSecretsLogged([NAME, SLUG]);
  });

  describe('deadline of the optional display claims', () => {
    afterEach(() => vi.useRealTimers());

    const hang = () => new Promise<never>(() => {});

    it('returns the base identity claims once the budget is spent on a hung directory', async () => {
      vi.useFakeTimers();
      state.findSlugEndpoint.mockReturnValue(hang());
      state.hasOtherOrganizations.mockReturnValue(hang());

      const pending = claimsFor('id_token');
      await vi.advanceTimersByTimeAsync(999);
      let settled = false;
      void pending.then(() => (settled = true));
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(2);

      const claims = await pending;
      expect(claims).toMatchObject({ sub: 'alice', email: 'a@example.com' });
      for (const name of ['tenant_name', 'tenant_slug', 'has_other_organizations'])
        expect(claims).not.toHaveProperty(name);
    });

    it('shares one budget: the slow lookup does not delay the one that answered', async () => {
      vi.useFakeTimers();
      state.findSlugEndpoint.mockReturnValue(hang());
      state.hasOtherOrganizations.mockResolvedValue(true);

      const pending = claimsFor('id_token');
      await vi.advanceTimersByTimeAsync(1001);

      expect(await pending).toMatchObject({ has_other_organizations: true });
    });

    it('cancels the cross-organization lookup when the budget is spent', async () => {
      vi.useFakeTimers();
      let signal: AbortSignal | undefined;
      state.hasOtherOrganizations.mockImplementation(
        (_email: string, _tenantId: string, options?: { signal?: AbortSignal }) => {
          signal = options?.signal;
          return hang();
        },
      );

      const pending = claimsFor('id_token');
      await vi.advanceTimersByTimeAsync(1001);
      await pending;

      expect(signal?.aborted).toBe(true);
    });

    it('does not cancel a lookup that finished in time', async () => {
      let signal: AbortSignal | undefined;
      state.hasOtherOrganizations.mockImplementation(
        async (_email: string, _tenantId: string, options?: { signal?: AbortSignal }) => {
          signal = options?.signal;
          return false;
        },
      );

      await claimsFor('id_token');

      expect(signal?.aborted).toBe(false);
    });
  });

  describe('has_other_organizations', () => {
    it.each([true, false])('reports %s to the desktop client in the id_token', async (value) => {
      state.hasOtherOrganizations.mockResolvedValue(value);

      expect(await claimsFor('id_token')).toMatchObject({ has_other_organizations: value });
      expect(state.hasOtherOrganizations).toHaveBeenCalledWith('a@example.com', 'tenant-acme', {
        signal: expect.any(AbortSignal),
      });
    });

    it('is not computed for userinfo', async () => {
      expect(await claimsFor('userinfo')).not.toHaveProperty('has_other_organizations');
      expect(state.hasOtherOrganizations).not.toHaveBeenCalled();
    });

    it('is not computed for other clients', async () => {
      for (const clientId of ['lobehub-web', 'lobehub-cli', 'lca_custom'])
        expect(await claimsFor('id_token', clientId)).not.toHaveProperty('has_other_organizations');
      expect(state.hasOtherOrganizations).not.toHaveBeenCalled();
    });

    it.each([
      ['the lookup is unknown', () => state.hasOtherOrganizations.mockResolvedValue(undefined)],
      ['the lookup throws', () => state.hasOtherOrganizations.mockRejectedValue(new Error('x'))],
    ])('is omitted, with the rest of the token intact, when %s', async (_name, arrange) => {
      arrange();

      const claims = await claimsFor('id_token');

      expect(claims).toMatchObject({ sub: 'alice', tenant_name: NAME });
      expect(claims).not.toHaveProperty('has_other_organizations');
    });

    it('is omitted for an account without an email', async () => {
      state.findUser.mockResolvedValue({ email: null, id: 'alice', username: 'alice' });

      expect(await claimsFor('id_token')).not.toHaveProperty('has_other_organizations');
      expect(state.hasOtherOrganizations).not.toHaveBeenCalled();
    });

    it('keeps the email out of the logs', async () => {
      state.hasOtherOrganizations.mockRejectedValue(new Error('failed for a@example.com'));

      await claimsFor('id_token');

      expectNoSecretsLogged(['a@example.com']);
    });
  });
});

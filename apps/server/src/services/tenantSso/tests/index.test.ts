// @vitest-environment node
import type { SsoProviderItem } from '@lobechat/database/tenant/schemas';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { sealTenantData } from '@/server/crypto/tenantKeys';

import {
  publicSsoLogoUrl,
  ssoSecretAad,
  tenantSsoCallbackPath,
  toGenericOAuthConfig,
  toPublicSsoProvider,
  toTenantSsoProvider,
} from '../index';

const TENANT = 'tenant-sso-1';
const previousSecret = process.env.KEY_VAULTS_SECRET;

const row = (overrides: Partial<SsoProviderItem> = {}): SsoProviderItem => ({
  admissionPolicy: 'allowlist',
  createdAt: new Date(),
  deletedAt: null,
  displayName: 'Okta',
  enabled: true,
  id: 'sso_1',
  issuer: 'https://idp.example.com/',
  logoUrl: null,
  oauth2Config: null,
  oidcConfig: { clientId: 'client-1', pkce: true, scopes: ['openid', 'profile', 'email'] },
  protocol: 'oidc',
  providerId: 'okta',
  revision: 3,
  secretConfigEncrypted: sealTenantData(
    TENANT,
    JSON.stringify({ clientSecret: 's3cret' }),
    ssoSecretAad(TENANT, 'okta', 3),
  ),
  updatedAt: new Date(),
  ...overrides,
});

beforeAll(() => {
  process.env.KEY_VAULTS_SECRET = 'sso-test-master-secret';
});

afterAll(() => {
  process.env.KEY_VAULTS_SECRET = previousSecret;
});

describe('tenant SSO reader', () => {
  it('opens the secret sealed for this tenant, provider and revision', () => {
    const provider = toTenantSsoProvider(TENANT, row());
    expect(provider?.secrets.clientSecret).toBe('s3cret');

    const config = toGenericOAuthConfig(
      provider!,
      `https://app.example.com/t/acme${tenantSsoCallbackPath('okta')}`,
    );
    expect(config).toMatchObject({
      clientId: 'client-1',
      clientSecret: 's3cret',
      providerId: 'okta',
      redirectURI: 'https://app.example.com/t/acme/api/auth/callback/okta',
    });
  });

  it('drops a provider whose secret was sealed for another tenant or revision', () => {
    expect(toTenantSsoProvider('tenant-other', row())).toBeNull();
    expect(toTenantSsoProvider(TENANT, row({ revision: 4 }))).toBeNull();
  });

  it('drops disabled and deleted providers', () => {
    expect(toTenantSsoProvider(TENANT, row({ enabled: false }))).toBeNull();
    expect(toTenantSsoProvider(TENANT, row({ deletedAt: new Date() }))).toBeNull();
  });

  // SAML and the named OAuth2 vendors were retired: only OIDC and custom OAuth2 run.
  // Rows already stored by an older build are skipped, never half-loaded.
  describe('retired and unknown protocols', () => {
    const customOAuth2 = {
      authorizationEndpoint: 'https://idp.example.com/authorize',
      clientId: 'client-1',
      preset: 'custom' as const,
      tokenEndpoint: 'https://idp.example.com/token',
      userInfoEndpoint: 'https://idp.example.com/userinfo',
    };
    const oauth2 = (config: unknown) =>
      row({ oauth2Config: config as never, oidcConfig: null, protocol: 'oauth2' });

    it('skips legacy SAML rows', () => {
      expect(toTenantSsoProvider(TENANT, row({ protocol: 'saml' }))).toBeNull();
    });

    it.each(['dingtalk', 'discord', 'feishu', 'github', 'wecom', 'okta', undefined])(
      'skips OAuth2 rows with the %s preset',
      (preset) => {
        expect(toTenantSsoProvider(TENANT, oauth2({ ...customOAuth2, preset }))).toBeNull();
      },
    );

    it.each(['bridge', 'ldap', ''])('skips rows with the %j protocol', (protocol) => {
      expect(toTenantSsoProvider(TENANT, row({ protocol }))).toBeNull();
    });

    it('keeps OIDC and custom OAuth2 rows', () => {
      expect(toTenantSsoProvider(TENANT, row())?.protocol).toBe('oidc');
      expect(toTenantSsoProvider(TENANT, oauth2(customOAuth2))?.protocol).toBe('oauth2');
    });
  });

  describe('display name fallback', () => {
    const oidc = () => toGenericOAuthConfig(toTenantSsoProvider(TENANT, row())!, 'https://x')!;
    const custom = () =>
      toGenericOAuthConfig(
        toTenantSsoProvider(
          TENANT,
          row({
            oauth2Config: {
              authorizationEndpoint: 'https://idp.example.com/authorize',
              clientId: 'client-1',
              preset: 'custom',
              tokenEndpoint: 'https://idp.example.com/token',
              userInfoEndpoint: 'https://idp.example.com/userinfo',
            },
            oidcConfig: null,
            protocol: 'oauth2',
          }),
        )!,
        'https://x',
      )!;

    it.each([
      ['OIDC', oidc],
      ['custom OAuth2', custom],
    ])(
      '%s: a profile without name (Clerk-like) is named by preferred_username',
      async (_, build) => {
        const mapped = await build().mapProfileToUser!({
          email: 'cpc@x.com',
          emailVerified: true,
          id: 'user_1',
          preferred_username: 'cpc_admin',
          sub: 'user_1',
        });
        expect(mapped.name).toBe('cpc_admin');
      },
    );

    it('falls back to the email, then the subject, and keeps a given name', async () => {
      const { mapProfileToUser } = oidc();
      expect((await mapProfileToUser!({ email: 'cpc@x.com', sub: 'u1' })).name).toBe('cpc@x.com');
      expect((await mapProfileToUser!({ sub: 'u1' })).name).toBe('u1');
      expect(
        (await mapProfileToUser!({ email: 'a@x.com', name: 'Ada', preferred_username: 'ada' }))
          .name,
      ).toBe('Ada');
    });

    it('composes given and family names before other claims', async () => {
      const mapped = await oidc().mapProfileToUser!({
        family_name: 'Lovelace',
        given_name: 'Ada',
        preferred_username: 'ada',
      });
      expect(mapped.name).toBe('Ada Lovelace');
    });

    it('does not override the email, image or verification better-auth merges from the profile', async () => {
      const mapped = await oidc().mapProfileToUser!({
        email: 'cpc@x.com',
        image: 'https://img/x.png',
        preferred_username: 'cpc_admin',
      });
      expect(mapped).toEqual({ name: 'cpc_admin' });
    });
  });
});

describe('public sign-in metadata', () => {
  it('exposes the provider id, display name, logo and protocol only', () => {
    const provider = toTenantSsoProvider(
      TENANT,
      row({
        displayName: 'Clerk',
        logoUrl: 'https://img.clerk.com/logo.png',
        providerId: 'clerk',
        secretConfigEncrypted: sealTenantData(
          TENANT,
          JSON.stringify({ clientSecret: 's3cret' }),
          ssoSecretAad(TENANT, 'clerk', 3),
        ),
      }),
    )!;

    const publicProvider = toPublicSsoProvider(provider);

    expect(publicProvider).toEqual({
      displayName: 'Clerk',
      id: 'clerk',
      logoUrl: 'https://img.clerk.com/logo.png',
      protocol: 'oidc',
    });
    expect(JSON.stringify(publicProvider)).not.toContain('s3cret');
    expect(JSON.stringify(publicProvider)).not.toContain('client-1');
    expect(JSON.stringify(publicProvider)).not.toContain('idp.example.com');
  });

  it('serves no logo for a provider without one', () => {
    const provider = toTenantSsoProvider(TENANT, row({ logoUrl: null }))!;
    expect(toPublicSsoProvider(provider).logoUrl).toBeNull();
  });

  it.each([
    ['https://cdn.example.com/a.png', 'https://cdn.example.com/a.png'],
    ['  https://cdn.example.com/a.png  ', 'https://cdn.example.com/a.png'],
    // Admin's frontend scope only stores public https URLs. Anything else (a hosted asset
    // reference that lives in Admin, inline data, plain http, credentials) is not loadable
    // from the sign-in page and must not reach an <img src>.
    ['http://cdn.example.com/a.png', null],
    ['data:image/png;base64,AAAA', null],
    ['javascript:alert(1)', null],
    ['/api/sso/logo/abc', null],
    ['//cdn.example.com/a.png', null],
    ['https://user:pass@cdn.example.com/a.png', null],
    ['not a url', null],
    ['', null],
    [null, null],
  ])('publicSsoLogoUrl(%j) -> %j', (value, expected) => {
    expect(publicSsoLogoUrl(value)).toBe(expected);
  });

  it('drops a logo URL longer than Admin accepts', () => {
    expect(publicSsoLogoUrl(`https://cdn.example.com/${'a'.repeat(2048)}`)).toBeNull();
  });
});

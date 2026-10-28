// @vitest-environment node
import type { SsoProviderItem } from '@lobechat/database/tenant/schemas';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { sealTenantData } from '@/server/crypto/tenantKeys';
import {
  ssoSecretAad,
  type TenantSsoProvider,
  toPublicSsoProvider,
  toTenantSsoProvider,
} from '@/server/services/tenantSso';

import { buildTenantSsoProviders } from './tenant-sso';

const TENANT = 'tenant-sso-1';
const previousSecret = process.env.KEY_VAULTS_SECRET;

const redirectURI = (providerId: string) => `https://app.example.com/callback/${providerId}`;

const oidc = (overrides: Partial<TenantSsoProvider> = {}): TenantSsoProvider => ({
  admissionPolicy: 'allowlist',
  config: { clientId: 'client-1' },
  displayName: 'Okta',
  issuer: 'https://idp.example.com',
  logoUrl: null,
  protocol: 'oidc',
  providerId: 'okta',
  revision: 1,
  secrets: { clientSecret: 's3cret' },
  ...overrides,
});

const custom = (overrides: Partial<TenantSsoProvider> = {}): TenantSsoProvider => ({
  admissionPolicy: 'allowlist',
  config: {
    authorizationEndpoint: 'https://idp.example.com/authorize',
    clientId: 'client-1',
    preset: 'custom',
    tokenEndpoint: 'https://idp.example.com/token',
    userInfoEndpoint: 'https://idp.example.com/userinfo',
  },
  displayName: 'Custom',
  issuer: '',
  logoUrl: null,
  protocol: 'oauth2',
  providerId: 'custom-idp',
  revision: 1,
  secrets: { clientSecret: 's3cret' },
  ...overrides,
});

describe('buildTenantSsoProviders', () => {
  describe('oidc rows', () => {
    it.each([
      'okta',
      'google',
      'github',
      'apple',
      'cognito',
      'microsoft',
      'microsoft-entra-id',
      'feishu',
      'wechat',
      'auth0',
    ])('runs a row named %s as generic OIDC, never as a built-in preset', (providerId) => {
      const set = buildTenantSsoProviders([oidc({ providerId })], redirectURI);

      expect(set.genericProviderIds).toEqual([providerId]);
      expect(set.providers.map((provider) => provider.providerId)).toEqual([providerId]);
      expect(set.genericOAuthProviders).toHaveLength(1);
      expect(set.genericOAuthProviders[0]).toMatchObject({
        clientId: 'client-1',
        clientSecret: 's3cret',
        pkce: true,
        providerId,
        redirectURI: redirectURI(providerId),
        scopes: ['openid', 'email', 'profile'],
      });
      // Built-in social providers no longer exist for tenants.
      expect(set).not.toHaveProperty('socialProviders');
    });

    it('takes the endpoints from the safely prefetched discovery document, not from better-auth', () => {
      const discoveryUrl = 'https://idp.example.com/.well-known/openid-configuration';
      const { genericOAuthProviders } = buildTenantSsoProviders(
        [
          oidc({
            discovery: {
              [discoveryUrl]: {
                authorization_endpoint: 'https://idp.example.com/authorize',
                token_endpoint: 'https://idp.example.com/token',
                userinfo_endpoint: 'https://idp.example.com/userinfo',
              },
            },
          }),
        ],
        redirectURI,
      );

      expect(genericOAuthProviders[0]).toMatchObject({
        authorizationUrl: 'https://idp.example.com/authorize',
        tokenUrl: 'https://idp.example.com/token',
        userInfoUrl: 'https://idp.example.com/userinfo',
      });
      expect(genericOAuthProviders[0].discoveryUrl).toBeUndefined();
      expect(genericOAuthProviders[0].getToken).toBeTypeOf('function');
      expect(genericOAuthProviders[0].getUserInfo).toBeTypeOf('function');
    });

    it('does not leave an issuer to better-auth discovery, which has no SSRF guard', () => {
      const { genericOAuthProviders } = buildTenantSsoProviders(
        [oidc({ issuer: 'http://169.254.169.254' })],
        redirectURI,
      );

      expect(genericOAuthProviders).toHaveLength(1);
      expect(genericOAuthProviders[0].discoveryUrl).toBeUndefined();
      expect(genericOAuthProviders[0].getToken).toBeTypeOf('function');
      expect(genericOAuthProviders[0].getUserInfo).toBeTypeOf('function');
    });

    it('uses saved endpoints without discovery', () => {
      const { genericOAuthProviders } = buildTenantSsoProviders(
        [
          oidc({
            config: {
              authorizationEndpoint: 'https://saved.example.com/authorize',
              clientId: 'client-1',
              tokenEndpoint: 'https://saved.example.com/token',
              tokenEndpointAuthentication: 'client_secret_basic',
              userInfoEndpoint: 'https://saved.example.com/userinfo',
            },
          }),
        ],
        redirectURI,
      );

      expect(genericOAuthProviders[0]).toMatchObject({
        authentication: 'basic',
        authorizationUrl: 'https://saved.example.com/authorize',
        tokenUrl: 'https://saved.example.com/token',
        userInfoUrl: 'https://saved.example.com/userinfo',
      });
    });

    it('names a user whose profile has no name claim', async () => {
      const { genericOAuthProviders } = buildTenantSsoProviders([oidc()], redirectURI);

      expect(
        await genericOAuthProviders[0].mapProfileToUser?.({
          email: 'cpc@x.com',
          preferred_username: 'cpc_admin',
          sub: 'u1',
        }),
      ).toEqual({ name: 'cpc_admin' });
    });

    it('leaves out a row without a client secret and keeps the others', () => {
      const set = buildTenantSsoProviders(
        [oidc({ providerId: 'broken', secrets: {} }), oidc({ providerId: 'fine' })],
        redirectURI,
      );

      expect(set.genericProviderIds).toEqual(['fine']);
    });
  });

  describe('oauth2 rows', () => {
    it('runs a custom row as generic OAuth 2.0', async () => {
      const set = buildTenantSsoProviders(
        [
          custom({
            config: {
              ...custom().config,
              scopes: ['read'],
              tokenEndpointAuthentication: 'client_secret_basic',
            },
          }),
        ],
        redirectURI,
      );

      expect(set.genericProviderIds).toEqual(['custom-idp']);
      expect(set.genericOAuthProviders[0]).toMatchObject({
        authentication: 'basic',
        authorizationUrl: 'https://idp.example.com/authorize',
        clientId: 'client-1',
        providerId: 'custom-idp',
        redirectURI: redirectURI('custom-idp'),
        scopes: ['read'],
        tokenUrl: 'https://idp.example.com/token',
        userInfoUrl: 'https://idp.example.com/userinfo',
      });
      expect(
        await set.genericOAuthProviders[0].mapProfileToUser?.({
          email: 'cpc@x.com',
          preferred_username: 'cpc_admin',
          sub: 'u1',
        }),
      ).toEqual({ name: 'cpc_admin' });
    });

    it('keeps a custom row named after a retired vendor on the generic path', () => {
      const set = buildTenantSsoProviders([custom({ providerId: 'github' })], redirectURI);

      expect(set.genericProviderIds).toEqual(['github']);
      expect(set.genericOAuthProviders[0].authorizationUrl).toBe(
        'https://idp.example.com/authorize',
      );
    });

    it.each(['github', 'feishu', 'dingtalk', 'wecom', 'discord', 'okta', 'google', '', undefined])(
      'skips an oauth2 row whose preset is %s',
      (preset) => {
        const set = buildTenantSsoProviders(
          [
            custom({ config: { ...custom().config, preset }, providerId: 'github' }),
            custom({ providerId: 'kept' }),
          ],
          redirectURI,
        );

        expect(set.genericProviderIds).toEqual(['kept']);
        expect(set.providers.map((provider) => provider.providerId)).toEqual(['kept']);
      },
    );

    it('skips a custom row missing an endpoint without failing the others', () => {
      const set = buildTenantSsoProviders(
        [
          custom({
            config: { ...custom().config, userInfoEndpoint: undefined },
            providerId: 'no-userinfo',
          }),
          oidc(),
        ],
        redirectURI,
      );

      expect(set.genericProviderIds).toEqual(['okta']);
    });
  });

  it('keeps every callback on the generic provider id', () => {
    const set = buildTenantSsoProviders(
      [oidc({ providerId: 'okta' }), custom({ providerId: 'custom-idp' })],
      redirectURI,
    );

    expect(set.genericOAuthProviders.map((config) => config.redirectURI)).toEqual([
      'https://app.example.com/callback/okta',
      'https://app.example.com/callback/custom-idp',
    ]);
  });
});

describe('tenant rows to the front-desk list', () => {
  beforeAll(() => {
    process.env.KEY_VAULTS_SECRET = 'sso-test-master-secret';
  });

  afterAll(() => {
    process.env.KEY_VAULTS_SECRET = previousSecret;
  });

  const row = (overrides: Partial<SsoProviderItem> & { providerId: string }): SsoProviderItem => ({
    admissionPolicy: 'allowlist',
    createdAt: new Date(),
    deletedAt: null,
    displayName: overrides.providerId,
    enabled: true,
    id: `sso_${overrides.providerId}`,
    issuer: 'https://idp.example.com',
    logoUrl: null,
    oauth2Config: null,
    oidcConfig: { clientId: 'client-1' },
    protocol: 'oidc',
    revision: 1,
    secretConfigEncrypted: sealTenantData(
      TENANT,
      JSON.stringify({ clientSecret: 's3cret' }),
      ssoSecretAad(TENANT, overrides.providerId, 1),
    ),
    updatedAt: new Date(),
    ...overrides,
  });

  const oauth2Row = (providerId: string, preset: string, overrides = {}) =>
    row({
      issuer: '',
      oauth2Config: {
        authorizationEndpoint: 'https://idp.example.com/authorize',
        clientId: 'client-1',
        preset,
        tokenEndpoint: 'https://idp.example.com/token',
        userInfoEndpoint: 'https://idp.example.com/userinfo',
      } as SsoProviderItem['oauth2Config'],
      oidcConfig: null,
      protocol: 'oauth2',
      providerId,
      ...overrides,
    });

  /**
   * The scope Admin serves its own sign-in from (admin `loadSsoLoginOptions` /
   * `isSupportedProvider`): enabled, not soft-deleted, and either OIDC or OAuth 2.0 with preset
   * `custom`. Bridge is Admin-only and the CPC front desk has no receiver for it.
   */
  const adminScope = (rows: SsoProviderItem[]) =>
    rows
      .filter(
        (item) =>
          item.enabled &&
          !item.deletedAt &&
          (item.protocol === 'oidc' ||
            (item.protocol === 'oauth2' &&
              (item.oauth2Config as { preset?: unknown } | null)?.preset === 'custom')),
      )
      .map((item) => item.providerId);

  const frontDesk = (rows: SsoProviderItem[]) =>
    buildTenantSsoProviders(
      rows
        .map((item) => toTenantSsoProvider(TENANT, item))
        .filter((provider): provider is TenantSsoProvider => provider !== null),
      redirectURI,
    ).providers.map((provider) => provider.providerId);

  const makeRows = () => [
    row({ providerId: 'okta' }),
    row({ providerId: 'google' }),
    row({ providerId: 'microsoft-entra-id' }),
    oauth2Row('custom-idp', 'custom'),
    oauth2Row('github', 'github'),
    oauth2Row('feishu', 'feishu'),
    oauth2Row('dingtalk', 'dingtalk'),
    row({ issuer: '', oidcConfig: null, protocol: 'saml', providerId: 'saml-idp' } as never),
    row({ oidcConfig: null, protocol: 'bridge', providerId: 'bridge-idp' } as never),
    row({ enabled: false, providerId: 'disabled-oidc' }),
    row({ deletedAt: new Date(), providerId: 'deleted-oidc' }),
    oauth2Row('deleted-custom', 'custom', { deletedAt: new Date() }),
    oauth2Row('retired-github', 'github', { deletedAt: new Date(), enabled: false }),
  ];

  it('shows exactly what the Admin scope serves for OIDC and custom OAuth 2.0', () => {
    const rows = makeRows();
    expect(frontDesk(rows).toSorted()).toEqual(adminScope(rows).toSorted());
    expect(frontDesk(rows).toSorted()).toEqual([
      'custom-idp',
      'google',
      'microsoft-entra-id',
      'okta',
    ]);
  });

  it('does not show soft-deleted rows', () => {
    const list = frontDesk(makeRows());

    expect(list).not.toContain('deleted-oidc');
    expect(list).not.toContain('deleted-custom');
    expect(list).not.toContain('retired-github');
  });

  it('does not show retired protocols, named presets, disabled rows or bridge', () => {
    const list = frontDesk(makeRows());

    for (const id of ['github', 'feishu', 'dingtalk', 'saml-idp', 'bridge-idp', 'disabled-oidc'])
      expect(list).not.toContain(id);
  });

  it('publishes each shown provider as oidc or oauth2 with nothing else', () => {
    const providers = makeRows()
      .map((item) => toTenantSsoProvider(TENANT, item))
      .filter((provider): provider is TenantSsoProvider => provider !== null);

    expect(toPublicSsoProvider(providers.find((p) => p.providerId === 'custom-idp')!)).toEqual({
      displayName: 'custom-idp',
      id: 'custom-idp',
      logoUrl: null,
      protocol: 'oauth2',
    });
    expect(toPublicSsoProvider(providers.find((p) => p.providerId === 'google')!).protocol).toBe(
      'oidc',
    );
  });
});

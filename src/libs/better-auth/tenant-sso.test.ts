// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TenantSsoProvider } from '@/server/services/tenantSso';

import Google from './sso/providers/google';
import { buildTenantSsoProviders, tenantSsoPresetId } from './tenant-sso';

const provider = (overrides: Partial<TenantSsoProvider>): TenantSsoProvider => ({
  admissionPolicy: 'allowlist',
  config: { clientId: 'client-1' },
  displayName: 'IdP',
  issuer: 'https://idp.example.com',
  logoUrl: null,
  protocol: 'oidc',
  providerId: 'acme-idp',
  revision: 1,
  secrets: { clientSecret: 'tenant-secret' },
  ...overrides,
});

const redirectURI = (providerId: string) =>
  `https://app.example.com/t/acme/api/auth/callback/${providerId}`;

describe('tenant SSO presets', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('builds a built-in preset from the tenant credentials, never from the environment', () => {
    vi.stubEnv('AUTH_GOOGLE_ID', 'env-client');
    vi.stubEnv('AUTH_GOOGLE_SECRET', 'env-secret');
    const checkEnvs = vi.spyOn(Google, 'checkEnvs');

    const set = buildTenantSsoProviders([provider({ providerId: 'google' })], redirectURI);

    expect(checkEnvs).not.toHaveBeenCalled();
    expect(set.socialProviders.google).toEqual(
      expect.objectContaining({
        clientId: 'client-1',
        clientSecret: 'tenant-secret',
        prompt: 'select_account',
      }),
    );
    expect(set.genericOAuthProviders).toEqual([]);
    expect(set.providers.map((p) => p.providerId)).toEqual(['google']);
  });

  it('selects an OAuth2 preset by oauth2_config.preset', () => {
    const set = buildTenantSsoProviders(
      [
        provider({
          config: { clientId: 'gh-client', preset: 'github' },
          issuer: 'https://github.com',
          protocol: 'oauth2',
          providerId: 'github',
        }),
        provider({
          config: { clientId: 'cli_feishu', preset: 'feishu' },
          issuer: 'https://open.feishu.cn',
          protocol: 'oauth2',
          providerId: 'corp-feishu',
        }),
      ],
      redirectURI,
    );

    expect(set.socialProviders.github).toEqual(
      expect.objectContaining({ clientId: 'gh-client', clientSecret: 'tenant-secret' }),
    );
    // A generic preset runs under the row's provider id and the tenant callback.
    expect(set.genericProviderIds).toEqual(['corp-feishu']);
    expect(set.genericOAuthProviders[0]).toEqual(
      expect.objectContaining({
        clientId: 'cli_feishu',
        clientSecret: 'tenant-secret',
        providerId: 'corp-feishu',
        redirectURI: redirectURI('corp-feishu'),
      }),
    );
  });

  it('selects an OIDC preset by provider id and passes the issuer', () => {
    const set = buildTenantSsoProviders(
      [provider({ issuer: 'https://acme.okta.com/', providerId: 'okta' })],
      redirectURI,
    );

    expect(set.genericOAuthProviders).toEqual([
      expect.objectContaining({
        clientId: 'client-1',
        clientSecret: 'tenant-secret',
        discoveryUrl: 'https://acme.okta.com/.well-known/openid-configuration',
        providerId: 'okta',
        redirectURI: redirectURI('okta'),
      }),
    ]);
  });

  it('derives the Microsoft tenant from the issuer', () => {
    const set = buildTenantSsoProviders(
      [
        provider({
          issuer: 'https://login.microsoftonline.com/contoso-tenant/v2.0',
          providerId: 'microsoft',
        }),
      ],
      redirectURI,
    );

    expect(set.socialProviders.microsoft).toEqual(
      expect.objectContaining({
        authority: 'https://login.microsoftonline.com',
        clientId: 'client-1',
        tenantId: 'contoso-tenant',
      }),
    );
  });

  it('keeps plain OIDC and custom OAuth2 rows on the generic configuration', () => {
    const set = buildTenantSsoProviders(
      [
        provider({ providerId: 'acme-idp' }),
        provider({
          config: {
            authorizationEndpoint: 'https://oauth.example.com/authorize',
            clientId: 'custom-client',
            preset: 'custom',
            tokenEndpoint: 'https://oauth.example.com/token',
            userInfoEndpoint: 'https://oauth.example.com/userinfo',
          },
          protocol: 'oauth2',
          providerId: 'custom-oauth',
        }),
      ],
      redirectURI,
    );

    expect(tenantSsoPresetId(provider({ providerId: 'acme-idp' }))).toBeUndefined();
    expect(set.genericProviderIds).toEqual(['acme-idp', 'custom-oauth']);
    expect(set.socialProviders).toEqual({});
  });

  it('leaves out rows a preset cannot run', () => {
    const set = buildTenantSsoProviders(
      [
        // A built-in preset answers only under its own id.
        provider({
          config: { clientId: 'gh-client', preset: 'github' },
          protocol: 'oauth2',
          providerId: 'corp-github',
        }),
        // Cognito needs a hosted UI domain no field carries.
        provider({ providerId: 'cognito' }),
        // No client secret.
        provider({ providerId: 'okta', secrets: {} }),
        // OAuth2 presets this build has no module for.
        provider({ config: { clientId: 'x', preset: 'dingtalk' }, protocol: 'oauth2' }),
        provider({ config: { clientId: 'x', preset: 'wecom' }, protocol: 'oauth2' }),
        // SAML is not served.
        provider({ config: { entryPoint: 'https://idp' }, protocol: 'saml', providerId: 'saml' }),
      ],
      redirectURI,
    );

    expect(set.providers).toEqual([]);
    expect(set.socialProviders).toEqual({});
    expect(set.genericOAuthProviders).toEqual([]);
  });
});

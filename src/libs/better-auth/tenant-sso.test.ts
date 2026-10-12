// @vitest-environment node
import { describe, expect, it } from 'vitest';

import type { TenantSsoProvider } from '@/server/services/tenantSso';

import { buildTenantSsoProviders } from './tenant-sso';

const okta = (overrides: Partial<TenantSsoProvider> = {}): TenantSsoProvider => ({
  admissionPolicy: 'allowlist',
  config: { clientId: 'client-1', preset: 'okta' },
  displayName: 'Okta',
  issuer: 'https://idp.example.com',
  logoUrl: null,
  protocol: 'oauth2',
  providerId: 'okta',
  revision: 1,
  secrets: { clientSecret: 's3cret' },
  ...overrides,
});

describe('buildTenantSsoProviders presets', () => {
  it.each(['oidc', 'oauth2'] as const)(
    'uses saved endpoints for a named %s preset without discovery',
    (protocol) => {
      const { genericOAuthProviders } = buildTenantSsoProviders(
        [
          okta({
            config: {
              authorizationEndpoint: 'https://saved.example.com/authorize',
              clientId: 'client-1',
              preset: 'okta',
              tokenEndpoint: 'https://saved.example.com/token',
              tokenEndpointAuthentication: 'client_secret_basic',
              userInfoEndpoint: 'https://saved.example.com/userinfo',
            },
            protocol,
          }),
        ],
        (providerId) => `https://app.example.com/callback/${providerId}`,
      );

      expect(genericOAuthProviders[0]).toMatchObject({
        authentication: 'basic',
        authorizationUrl: 'https://saved.example.com/authorize',
        tokenUrl: 'https://saved.example.com/token',
        userInfoUrl: 'https://saved.example.com/userinfo',
      });
    },
  );

  it('does not leave a preset issuer to better-auth discovery, which has no SSRF guard', () => {
    const { genericOAuthProviders } = buildTenantSsoProviders(
      [okta({ issuer: 'http://169.254.169.254' })],
      (providerId) => `https://app.example.com/callback/${providerId}`,
    );

    expect(genericOAuthProviders).toHaveLength(1);
    expect(genericOAuthProviders[0].discoveryUrl).toBeUndefined();
    expect(genericOAuthProviders[0].getToken).toBeTypeOf('function');
    expect(genericOAuthProviders[0].getUserInfo).toBeTypeOf('function');
  });

  it('takes the endpoints from the safely prefetched discovery document', () => {
    const { genericOAuthProviders } = buildTenantSsoProviders(
      [
        okta({
          discovery: {
            'https://idp.example.com/.well-known/openid-configuration': {
              authorization_endpoint: 'https://idp.example.com/authorize',
              token_endpoint: 'https://idp.example.com/token',
              userinfo_endpoint: 'https://idp.example.com/userinfo',
            },
          },
        }),
      ],
      (providerId) => `https://app.example.com/callback/${providerId}`,
    );

    expect(genericOAuthProviders[0]).toMatchObject({
      authorizationUrl: 'https://idp.example.com/authorize',
      tokenUrl: 'https://idp.example.com/token',
      userInfoUrl: 'https://idp.example.com/userinfo',
    });
  });
});

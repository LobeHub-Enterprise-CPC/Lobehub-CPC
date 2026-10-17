// @vitest-environment node
import net from 'node:net';

import type { OAuth2Tokens } from 'better-auth/oauth2';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchOidcDiscovery, type TenantSsoProvider, toGenericOAuthConfig } from '../index';

/**
 * The tenant admin chooses every endpoint of an SSO provider, and better-auth's
 * generic OAuth calls them server-side (discovery, token, userinfo). None of
 * those calls may reach private or metadata addresses.
 */
const connectTargets: string[] = [];

beforeEach(() => {
  connectTargets.length = 0;
  vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(function (
    this: net.Socket,
    ...args: any[]
  ) {
    // net.connect() hands the normalized `[options, cb]` pair through as one array.
    const [first] = Array.isArray(args[0]) ? args[0] : args;
    connectTargets.push(`${first?.host}:${first?.port}`);
    this.destroy(new Error('network disabled in test'));
    return this;
  } as any);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.SSRF_ALLOW_PRIVATE_IP_ADDRESS;
});

const provider = (overrides: Partial<TenantSsoProvider> = {}): TenantSsoProvider => ({
  admissionPolicy: 'allowlist',
  config: {
    authorizationEndpoint: 'https://idp.example.com/authorize',
    clientId: 'client-1',
    preset: 'custom',
    tokenEndpoint: 'http://169.254.169.254/latest/api/token',
    userInfoEndpoint: 'http://10.0.0.8/userinfo',
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

const redirectURI = 'https://app.example.com/t/acme/api/auth/callback/custom-idp';

describe('tenant SSO outbound requests', () => {
  it('does not exchange the authorization code against a private token endpoint', async () => {
    const config = toGenericOAuthConfig(provider(), redirectURI)!;

    await expect(
      config.getToken!({ code: 'code', codeVerifier: 'verifier', redirectURI }),
    ).rejects.toBeDefined();

    expect(connectTargets).toEqual([]);
  });

  it('does not call a private userinfo endpoint with the access token', async () => {
    const config = toGenericOAuthConfig(provider(), redirectURI)!;

    await expect(
      config.getUserInfo!({ accessToken: 'access-token' } as OAuth2Tokens),
    ).rejects.toBeDefined();

    expect(connectTargets).toEqual([]);
  });

  it('never leaves OIDC discovery to better-auth, whose fetch is not SSRF-safe', () => {
    const config = toGenericOAuthConfig(
      provider({
        config: { clientId: 'client-1' },
        issuer: 'http://127.0.0.1:9000',
        protocol: 'oidc',
      }),
      redirectURI,
    )!;

    expect(config.discoveryUrl).toBeUndefined();
    expect(config.getToken).toBeTypeOf('function');
    expect(config.getUserInfo).toBeTypeOf('function');
  });

  it('uses the endpoints resolved by a safe discovery request', () => {
    const config = toGenericOAuthConfig(
      provider({
        config: { clientId: 'client-1' },
        discovery: {
          'https://idp.example.com/.well-known/openid-configuration': {
            authorization_endpoint: 'https://idp.example.com/authorize',
            token_endpoint: 'https://idp.example.com/token',
            userinfo_endpoint: 'https://idp.example.com/userinfo',
          },
        },
        issuer: 'https://idp.example.com',
        protocol: 'oidc',
      }),
      redirectURI,
    )!;

    expect(config).toMatchObject({
      authorizationUrl: 'https://idp.example.com/authorize',
      tokenUrl: 'https://idp.example.com/token',
      userInfoUrl: 'https://idp.example.com/userinfo',
    });
  });

  it('does not fetch a discovery document from a private issuer', async () => {
    await expect(
      fetchOidcDiscovery('http://169.254.169.254/.well-known/x'),
    ).resolves.toBeUndefined();

    expect(connectTargets).toEqual([]);
  });

  it('lets the deployment opt in to a private identity provider', async () => {
    process.env.SSRF_ALLOW_PRIVATE_IP_ADDRESS = '1';

    await fetchOidcDiscovery('http://10.0.0.8/.well-known/openid-configuration');

    expect(connectTargets).toContain('10.0.0.8:80');
  });
});

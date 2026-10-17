// @vitest-environment node
import type { LobeChatDatabase } from '@lobechat/database';
import type { SsoProviderItem } from '@lobechat/database/tenant/schemas';
import { ssrfSafeFetch } from '@lobechat/ssrf-safe-fetch';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchOidcDiscovery, loadTenantSsoProviders, toGenericOAuthConfig } from '../index';

vi.mock('@lobechat/ssrf-safe-fetch', () => ({ ssrfSafeFetch: vi.fn() }));

const transport = vi.mocked(ssrfSafeFetch);
const endpoints = {
  authorization_endpoint: 'https://idp.example.com/authorize',
  token_endpoint: 'https://idp.example.com/token',
  userinfo_endpoint: 'https://idp.example.com/userinfo',
};
const savedEndpoints = {
  authorizationEndpoint: endpoints.authorization_endpoint,
  tokenEndpoint: endpoints.token_endpoint,
  userInfoEndpoint: endpoints.userinfo_endpoint,
};
let sequence = 0;
const discoveryUrl = () => `https://idp.example.com/discovery/${++sequence}`;

const database = (overrides: Partial<SsoProviderItem> = {}) => {
  const row: SsoProviderItem = {
    admissionPolicy: 'allowlist',
    createdAt: new Date(),
    deletedAt: null,
    displayName: 'OIDC',
    enabled: true,
    id: 'sso-1',
    issuer: `https://idp.example.com/issuer/${++sequence}`,
    logoUrl: null,
    oauth2Config: null,
    oidcConfig: { clientId: 'client-1', ...savedEndpoints },
    protocol: 'oidc',
    providerId: 'custom-oidc',
    revision: 1,
    samlConfig: null,
    secretConfigEncrypted: null,
    updatedAt: new Date(),
    ...overrides,
  };
  const query = {
    from: () => query,
    orderBy: async () => [row],
    where: () => query,
  };
  return { select: () => query } as unknown as LobeChatDatabase;
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-12T12:00:00Z'));
  transport.mockReset();
  transport.mockImplementation(async () => Response.json(endpoints));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('tenant SSO discovery', () => {
  it.each(['oidc', 'oauth2'] as const)(
    'skips discovery for complete %s endpoints',
    async (protocol) => {
      const providers = await loadTenantSsoProviders(
        database({
          oauth2Config: { clientId: 'client-1', preset: 'okta', ...savedEndpoints },
          protocol,
        }),
        'tenant-a',
      );

      expect(providers).toHaveLength(1);
      expect(transport).not.toHaveBeenCalled();
    },
  );

  it('fetches only the explicit discovery URL when an endpoint is missing', async () => {
    const url = discoveryUrl();
    const providers = await loadTenantSsoProviders(
      database({ oidcConfig: { clientId: 'client-1', discoveryEndpoint: url } }),
      'tenant-a',
    );

    expect(providers[0].discovery?.[url]).toEqual(endpoints);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0][0]).toBe(url);
  });

  it('merges concurrent discovery requests and caches the successful response', async () => {
    const url = discoveryUrl();
    let resolve!: (response: Response) => void;
    transport.mockReturnValue(
      new Promise<Response>((done) => {
        resolve = done;
      }),
    );
    const requests = Array.from({ length: 8 }, () => fetchOidcDiscovery(url));

    resolve(Response.json(endpoints));
    expect(await Promise.all(requests)).toEqual(Array.from({ length: 8 }, () => endpoints));
    expect(await fetchOidcDiscovery(url)).toEqual(endpoints);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it.each(['network', 'http', 'json', 'missing-token'])(
    'negatively caches %s failures and retries after the bounded cooldown',
    async (failure) => {
      const url = discoveryUrl();
      if (failure === 'network') transport.mockRejectedValue(new Error('IdP unavailable'));
      else
        transport.mockResolvedValue(
          failure === 'http'
            ? new Response('', { status: 503 })
            : failure === 'json'
              ? new Response('not-json')
              : Response.json({ authorization_endpoint: endpoints.authorization_endpoint }),
        );

      expect(await Promise.all([fetchOidcDiscovery(url), fetchOidcDiscovery(url)])).toEqual([
        undefined,
        undefined,
      ]);
      vi.setSystemTime(Date.now() + 30_000);
      expect(await fetchOidcDiscovery(url)).toBeUndefined();
      expect(transport).toHaveBeenCalledTimes(1);

      vi.setSystemTime(Date.now() + 30_001);
      transport.mockResolvedValue(Response.json(endpoints));
      expect(await fetchOidcDiscovery(url)).toEqual(endpoints);
      expect(transport).toHaveBeenCalledTimes(2);
    },
  );

  it('refreshes successful discovery after five minutes', async () => {
    const url = discoveryUrl();
    expect(await fetchOidcDiscovery(url)).toEqual(endpoints);
    vi.setSystemTime(Date.now() + 300_001);
    const updated = { ...endpoints, token_endpoint: 'https://idp.example.com/new-token' };
    transport.mockResolvedValue(Response.json(updated));
    expect(await fetchOidcDiscovery(url)).toEqual(updated);
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it.each(['client_secret_basic', 'client_secret_post'])(
    'exchanges OIDC codes using %s without leaving transport to better-auth',
    async (authentication) => {
      const [provider] = await loadTenantSsoProviders(database(), 'tenant-a');
      provider.config.tokenEndpointAuthentication = authentication;
      provider.secrets.clientSecret = 'secret-1';
      const redirectURI = 'https://app.example.com/callback/custom-oidc';
      const config = toGenericOAuthConfig(provider, redirectURI)!;
      transport.mockResolvedValue(
        Response.json({ access_token: 'access-1', token_type: 'Bearer' }),
      );

      expect(await config.getToken!({ code: 'code-1', redirectURI })).toMatchObject({
        accessToken: 'access-1',
      });
      const [, request] = transport.mock.calls.at(-1)!;
      const headers = new Headers(request?.headers);
      const body = new URLSearchParams(String(request?.body));
      if (authentication === 'client_secret_basic') {
        expect(headers.get('authorization')).toBe(
          `Basic ${Buffer.from('client-1:secret-1').toString('base64')}`,
        );
        expect(body.has('client_secret')).toBe(false);
      } else {
        expect(headers.has('authorization')).toBe(false);
        expect(body.get('client_secret')).toBe('secret-1');
      }
    },
  );
});

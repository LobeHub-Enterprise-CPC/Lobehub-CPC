import type { GatewayIdentityResponse } from '@lobechat/agent-gateway-client';
import type { DataSyncConfig } from '@lobechat/electron-client-ipc';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDesktopGatewayIdentityProvider } from './gatewayIdentity';
import type * as SafeFetchModule from './safeFetch';

vi.mock('./safeFetch', async (importOriginal) => ({
  ...(await importOriginal<typeof SafeFetchModule>()),
  fetchNoRedirect: (...args: Parameters<typeof fetch>) => fetch(...args),
}));
const config = (tenantId = 'tenant-A', generation = 'login-A'): DataSyncConfig =>
  ({
    active: true,
    storageMode: 'cloud',
    cloudTenant: {
      generation,
      entryUrl: `https://example.test/t/${tenantId}`,
      display: { account: 'same-sub' },
      identity: {
        issuer: `https://example.test/t/${tenantId}/oidc`,
        subject: 'same-sub',
        tenantId,
      },
    },
  }) as DataSyncConfig;
const identity = (tenantId = 'tenant-A', authorizationId = 'source-A'): GatewayIdentityResponse => {
  const claims = {
    iss: 'urn:lobehub:gateway-session',
    purpose: 'gateway-connect',
    aud: 'urn:lobehub:gateway:device',
    tid: tenantId,
    sub: 'same-sub',
    principal: { kind: 'user' as const, id: 'same-sub' },
    capabilities: ['device:connect', 'device:respond'] as GatewayIdentityResponse['capabilities'],
    accepted_version: 7,
    authorization_id: authorizationId,
    connection_id: 'connection-1',
    device_id: 'device-1',
    exp: Math.floor(Date.now() / 1000) + 300,
  };
  return {
    tenancyProtocol: 1,
    tenantId,
    authorizationId,
    userId: 'same-sub',
    acceptedVersion: 7,
    principal: claims.principal,
    capabilities: claims.capabilities,
    gatewayTicket: `TEST.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.TEST`,
    ticketExpiresAt: claims.exp * 1000,
    authRecordExpiresAt: claims.exp * 1000,
  };
};
const reply = (data = identity()) =>
  Response.json(data, {
    headers: { 'X-LobeHub-Gateway-Tenancy': '1', 'X-LobeHub-Tenant-Id': data.tenantId },
  });
const input = () => ({
  connectionId: 'connection-1',
  deviceId: 'device-1',
  signal: new AbortController().signal,
});
afterEach(() => vi.restoreAllMocks());

describe('desktop committed login identity provider', () => {
  it('does not exchange tickets before confirmation or for unbound stored logins', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    await expect(
      createDesktopGatewayIdentityProvider({
        getConfig: async () => ({ active: false }) as DataSyncConfig,
        getAccessToken: async () => 'oidc',
        isPaused: () => false,
      }),
    ).rejects.toThrow('GATEWAY_LOGIN_CONFIRMATION_REQUIRED');
    await expect(
      createDesktopGatewayIdentityProvider({
        getConfig: async () => ({ active: true, storageMode: 'cloud' }) as DataSyncConfig,
        getAccessToken: async () => 'legacy',
        isPaused: () => false,
      }),
    ).rejects.toThrow('GATEWAY_LOGIN_CONFIRMATION_REQUIRED');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('names the account of the committed login so the device can be derived before the ticket', async () => {
    const provider = await createDesktopGatewayIdentityProvider({
      getConfig: async () => config(),
      getAccessToken: async () => 'oidc',
      isPaused: () => false,
    });
    expect(provider.subject).toBe('same-sub');
  });
  it('asks Work to sign the device and connection of this install', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => reply());
    const provider = await createDesktopGatewayIdentityProvider({
      getConfig: async () => config(),
      getAccessToken: async () => 'oidc',
      isPaused: () => false,
    });
    await provider(input());
    expect(JSON.parse(fetcher.mock.calls[0][1]!.body as string)).toMatchObject({
      connectionId: 'connection-1',
      deviceId: 'device-1',
    });
  });
  it('captures original OIDC credential and sends renewAuthorizationId on renewal', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => reply());
    let token = 'original-oidc';
    const provider = await createDesktopGatewayIdentityProvider({
      getConfig: async () => config(),
      getAccessToken: async () => token,
      isPaused: () => false,
    });
    await provider(input());
    token = 'other-oidc';
    await provider(input());
    expect(JSON.parse(fetcher.mock.calls[1][1]!.body as string).renewAuthorizationId).toBe(
      'source-A',
    );
    for (const [, request] of fetcher.mock.calls) {
      const headers = new Headers(request!.headers);
      expect(headers.get('Authorization')).toBe('Bearer original-oidc');
      expect(headers.has('Oidc-Auth')).toBe(false);
      expect(headers.has('X-API-Key')).toBe(false);
    }
  });
  it('drops a mint arriving after A/B switch with the same subject', async () => {
    let release!: (res: Response) => void;
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    let current = config();
    const provider = await createDesktopGatewayIdentityProvider({
      getConfig: async () => current,
      getAccessToken: async () => 'original-oidc',
      isPaused: () => false,
    });
    const pending = provider(input());
    await vi.waitFor(() => expect(release).toBeDefined());
    current = config('tenant-B', 'login-B');
    release(reply());
    await expect(pending).rejects.toThrow('GATEWAY_IDENTITY_CHANGED');
  });
  it('preserves workspace permission refusal separately from tenant lifecycle errors', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      Response.json({ tenancyProtocol: 1, error: { code: 'FORBIDDEN' } }, { status: 403 }),
    );
    const provider = await createDesktopGatewayIdentityProvider(
      {
        getConfig: async () => config(),
        getAccessToken: async () => 'oidc',
        isPaused: () => false,
      },
      'workspace',
    );
    await expect(provider(input())).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
  });

  it('refuses a replaced authorization response', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(reply())
      .mockResolvedValueOnce(reply(identity('tenant-A', 'other-source')));
    const provider = await createDesktopGatewayIdentityProvider({
      getConfig: async () => config(),
      getAccessToken: async () => 'oidc',
      isPaused: () => false,
    });
    await provider(input());
    await expect(provider(input())).rejects.toThrow('GATEWAY_IDENTITY_CHANGED');
  });
  it('cannot revive after logout or changed generation on the same tenant', async () => {
    let current = config();
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => reply());
    const provider = await createDesktopGatewayIdentityProvider({
      getConfig: async () => current,
      getAccessToken: async () => 'oidc',
      isPaused: () => false,
    });
    await provider(input());
    current = config('tenant-A', 'new-login');
    await expect(provider(input())).rejects.toThrow('GATEWAY_IDENTITY_CHANGED');
    current.active = false;
    await expect(provider(input())).rejects.toThrow('GATEWAY_IDENTITY_CHANGED');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

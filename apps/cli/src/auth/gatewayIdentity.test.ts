import type { GatewayIdentityResponse } from '@lobechat/agent-gateway-client';
import { extractBearerToken } from '@lobechat/utils/server/auth';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createGatewayIdentityProvider } from './gatewayIdentity';

// Keep the real parser used by OpenAPI auth; session helpers in its module are unused.
vi.mock('@/auth', () => ({ auth: {} }));

const identity = (overrides: Partial<GatewayIdentityResponse> = {}): GatewayIdentityResponse => {
  const response = {
    tenancyProtocol: 1 as const,
    tenantId: 'tenant-A',
    userId: 'same-sub',
    principal: { kind: 'user' as const, id: 'same-sub' },
    capabilities: ['device:connect', 'device:respond'] as GatewayIdentityResponse['capabilities'],
    authorizationId: 'original-source',
    acceptedVersion: 7,
    ticketExpiresAt: Math.floor(Date.now() / 1000) * 1000 + 300_000,
    authRecordExpiresAt: Math.floor(Date.now() / 1000) * 1000 + 300_000,
    ...overrides,
  };
  const claims = {
    iss: 'urn:lobehub:gateway-session',
    purpose: 'gateway-connect',
    aud: 'urn:lobehub:gateway:device',
    tid: response.tenantId,
    sub: response.userId,
    principal: response.principal,
    capabilities: response.capabilities,
    accepted_version: response.acceptedVersion,
    authorization_id: response.authorizationId,
    exp: Math.floor(response.ticketExpiresAt / 1000),
  };
  return {
    ...response,
    gatewayTicket: `TEST.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.TEST`,
  };
};
const reply = (data = identity()) =>
  Response.json(data, {
    headers: { 'X-LobeHub-Gateway-Tenancy': '1', 'X-LobeHub-Tenant-Id': data.tenantId },
  });
const auth = {
  serverUrl: 'https://example.test/t/a',
  token: 'original-api-key',
  tokenType: 'apiKey' as const,
  userId: 'same-sub',
};
const input = () => ({ signal: new AbortController().signal });
afterEach(() => vi.restoreAllMocks());

describe('CLI original-source gateway identity', () => {
  it.each(['apiKey', 'jwt'] as const)(
    'exchanges and renews %s with the original Bearer credential',
    async (tokenType) => {
      const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => reply());
      const mutable = { ...auth, tokenType };
      const provider = createGatewayIdentityProvider(mutable);
      const first = await provider(input());
      mutable.token = 'other-key';
      await provider(input());
      expect(String(fetcher.mock.calls[0][0])).toBe(
        'https://example.test/t/a/api/v1/gateway/identity',
      );
      const init = fetcher.mock.calls[1][1]!;
      expect(JSON.parse(init.body as string).renewAuthorizationId).toBe(first.authorizationId);
      for (const [, request] of fetcher.mock.calls) {
        const headers = new Headers(request!.headers);
        expect(headers.get('Authorization')).toBe(`Bearer ${auth.token}`);
        expect(headers.has('X-API-Key')).toBe(false);
        expect(headers.has('Oidc-Auth')).toBe(false);
      }
      expect(init.redirect).toBe('error');
    },
  );

  it.each(['apiKey', 'jwt'] as const)(
    'has its %s mint and renew recognized by the actual OpenAPI Bearer parser',
    async (tokenType) => {
      const accepted: string[] = [];
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
        const token = extractBearerToken(new Headers(init!.headers).get('Authorization'));
        if (token !== auth.token)
          return Response.json({ error: { code: 'SOURCE_UNVERIFIABLE' } }, { status: 401 });
        accepted.push(token);
        return reply();
      });
      const provider = createGatewayIdentityProvider({ ...auth, tokenType });
      const first = await provider(input());
      const renewed = await provider(input());
      expect(renewed.authorizationId).toBe(first.authorizationId);
      expect(accepted).toEqual([auth.token, auth.token]);
    },
  );

  it('rejects an authorization ID replaced by the server during renew', async () => {
    const fetcher = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(reply())
      .mockResolvedValueOnce(reply(identity({ authorizationId: 'other-source' })));
    const provider = createGatewayIdentityProvider(auth);
    await provider(input());
    await expect(provider(input())).rejects.toThrow('GATEWAY_IDENTITY_CHANGED');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('drops a late mint after logout or a tenant/source switch with the same sub', async () => {
    let resolve!: (response: Response) => void;
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    let current = true;
    const provider = createGatewayIdentityProvider(auth, { isCurrent: () => current });
    const pending = provider(input());
    current = false;
    resolve(reply());
    await expect(pending).rejects.toThrow('GATEWAY_IDENTITY_CHANGED');
  });

  it('does not follow redirects or downgrade to old identity endpoints', async () => {
    const fetcher = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 426 }));
    await expect(createGatewayIdentityProvider(auth)(input())).rejects.toThrow(
      'GATEWAY_TENANCY_UNSUPPORTED',
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('preserves permission failure codes for the device account explanation', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({ tenancyProtocol: 1, error: { code: 'FORBIDDEN' } }, { status: 403 }),
    );
    await expect(
      createGatewayIdentityProvider(auth, { workspaceId: 'ws-same' })(input()),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
  });

  it('keeps workspace and personal authorizations separate', async () => {
    const workspace = identity({
      authorizationId: 'workspace-source',
      principal: { kind: 'workspace', id: 'ws-same' },
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => reply(workspace));
    const provider = createGatewayIdentityProvider(auth, {
      workspaceId: 'ws-same',
      initialTicket: identity({ ...workspace, authorizationId: 'browser-session-source' })
        .gatewayTicket,
    });
    await provider(input());
    await provider(input());
    expect(JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string)).not.toHaveProperty(
      'renewAuthorizationId',
    );
    const call = vi.mocked(fetch).mock.calls[1][1]!;
    expect(JSON.parse(call.body as string)).toMatchObject({
      workspaceId: 'ws-same',
      renewAuthorizationId: 'workspace-source',
    });
    await expect(
      createGatewayIdentityProvider(auth, { initialTicket: workspace.gatewayTicket })(input()),
    ).rejects.toThrow('GATEWAY_IDENTITY_CHANGED');
  });
});

import { describe, expect, it, vi } from 'vitest';

import type { GatewayIdentityResponse } from '../../types/src/gateway';
import type { GatewayIdentityMinterOptions } from './identityMint';
import { createGatewayIdentityMinter } from './identityMint';

const identity = (overrides: Partial<GatewayIdentityResponse> = {}): GatewayIdentityResponse => {
  const response = {
    tenancyProtocol: 1 as const,
    tenantId: 'tenant-A',
    userId: 'sub',
    principal: { kind: 'user' as const, id: 'sub' },
    capabilities: ['device:connect', 'device:respond'] as GatewayIdentityResponse['capabilities'],
    authorizationId: 'source-A',
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
    gatewayTicket: `TEST.${btoa(JSON.stringify(claims)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')}.TEST`,
  };
};
const reply = (data = identity()) =>
  Response.json(data, {
    headers: { 'X-LobeHub-Gateway-Tenancy': '1', 'X-LobeHub-Tenant-Id': data.tenantId },
  });
const input = () => ({ signal: new AbortController().signal });
const minter = (
  send: GatewayIdentityMinterOptions['fetch'],
  overrides: Partial<GatewayIdentityMinterOptions> = {},
) =>
  createGatewayIdentityMinter({
    assertCurrent: () => undefined,
    entryUrl: 'https://example.test/t/a',
    fetch: send,
    token: 'original',
    userId: 'sub',
    ...overrides,
  });

describe('createGatewayIdentityMinter', () => {
  it.each([
    'http://example.test/t/a',
    'https://user:pass@example.test/t/a',
    'https://example.test/t/a?x=1',
    'https://example.test/t/a#frag',
  ])('refuses the unsafe entry %s before any request', (entryUrl) => {
    const send = vi.fn();
    expect(() => minter(send, { entryUrl })).toThrow('GATEWAY_IDENTITY_ENTRY_INVALID');
    expect(send).not.toHaveBeenCalled();
  });

  it('allows plain http only for loopback', async () => {
    const send = vi.fn(async () => reply());
    await minter(send, { entryUrl: 'http://127.0.0.1:3210' })(input());
    expect(send.mock.calls[0][0]).toBe('http://127.0.0.1:3210/api/v1/gateway/identity');
  });

  it('pins the expected tenant even on the first response', async () => {
    const send = vi.fn(async () => reply(identity({ tenantId: 'tenant-B' })));
    await expect(minter(send, { tenantId: 'tenant-A' })(input())).rejects.toThrow(
      'GATEWAY_IDENTITY_CHANGED',
    );
  });

  it('renews only the original authorization and tenant', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce(reply())
      .mockResolvedValueOnce(reply(identity({ tenantId: 'tenant-B' })));
    const provider = minter(send);
    await provider(input());
    await expect(provider(input())).rejects.toThrow('GATEWAY_IDENTITY_CHANGED');
    expect(JSON.parse(send.mock.calls[1][1].body).renewAuthorizationId).toBe('source-A');
  });

  it('requires the workspace principal when a workspace is shared', async () => {
    const send = vi.fn(async () => reply());
    await expect(minter(send, { workspaceId: 'ws' })(input())).rejects.toThrow(
      'GATEWAY_IDENTITY_CHANGED',
    );
  });

  it('does not let a failed renewal fail the next independent caller', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(reply());
    const provider = minter(send);
    const first = provider(input());
    const second = provider(input());
    await expect(first).rejects.toMatchObject({ code: 'GATEWAY_AUTHORITY_UNAVAILABLE' });
    await expect(second).resolves.toMatchObject({ authorizationId: 'source-A' });
  });

  it('maps a protocol error code only when it is in the frozen catalog', async () => {
    const send = vi.fn(async () =>
      Response.json({ error: { code: 'NOT_A_CODE' } }, { status: 403 }),
    );
    await expect(minter(send)(input())).rejects.toMatchObject({ code: 'SOURCE_UNVERIFIABLE' });
  });
});

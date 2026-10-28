import { describe, expect, it, vi } from 'vitest';

import type { GatewayIdentityResponse } from '../../types/src/gateway';
import type { GatewayIdentityMinterOptions } from './identityMint';
import { createGatewayIdentityMinter } from './identityMint';

const identity = (
  overrides: Partial<GatewayIdentityResponse> = {},
  ticket: Record<string, unknown> = { device_id: 'device-1', connection_id: 'connection-1' },
): GatewayIdentityResponse => {
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
    ...ticket,
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
const input = () => ({
  connectionId: 'connection-1',
  deviceId: 'device-1',
  signal: new AbortController().signal,
});
const minter = (
  send: GatewayIdentityMinterOptions['fetch'],
  overrides: Partial<GatewayIdentityMinterOptions> = {},
) =>
  createGatewayIdentityMinter({
    assertCurrent: () => undefined,
    entryUrl: 'https://example.test/orgs/a',
    fetch: send,
    token: 'original',
    userId: 'sub',
    ...overrides,
  });

describe('createGatewayIdentityMinter', () => {
  it.each([
    'http://example.test/orgs/a',
    'https://user:pass@example.test/orgs/a',
    'https://example.test/orgs/a?x=1',
    'https://example.test/orgs/a#frag',
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

  describe('device identity', () => {
    it("asks Work to sign the caller's own device and connection", async () => {
      const send = vi.fn(async () => reply());
      await minter(send)(input());
      expect(JSON.parse(send.mock.calls[0][1].body)).toMatchObject({
        audience: 'urn:lobehub:gateway:device',
        connectionId: 'connection-1',
        deviceId: 'device-1',
      });
    });

    it('sends the same device and connection again when it renews', async () => {
      const send = vi.fn(async () => reply());
      const provider = minter(send);
      await provider(input());
      await provider(input());
      expect(JSON.parse(send.mock.calls[1][1].body)).toMatchObject({
        connectionId: 'connection-1',
        deviceId: 'device-1',
        renewAuthorizationId: 'source-A',
      });
    });

    it.each([
      ['no device', { connectionId: 'connection-1' }],
      ['no connection', { deviceId: 'device-1' }],
      ['neither', {}],
    ])('does not ask for a device ticket with %s', async (_name, ids) => {
      const send = vi.fn(async () => reply());
      await expect(minter(send)({ signal: new AbortController().signal, ...ids })).rejects.toThrow(
        'INVALID_GATEWAY_MESSAGE',
      );
      expect(send).not.toHaveBeenCalled();
    });

    it.each([
      ['another device', { device_id: 'device-of-another-member', connection_id: 'connection-1' }],
      ['another connection', { device_id: 'device-1', connection_id: 'connection-2' }],
      ['no device at all', {}],
    ])('refuses a ticket that names %s', async (_name, claims) => {
      const send = vi.fn(async () => reply(identity({}, claims)));
      await expect(minter(send)(input())).rejects.toThrow('GATEWAY_IDENTITY_CHANGED');
    });

    it('lets an agent client ask for a signed connection but never a device', async () => {
      const send = vi.fn(async () =>
        Response.json(
          {
            ...identity(
              { capabilities: ['agent:observe'] },
              { connection_id: 'tab-1', operation_id: 'op', aud: 'urn:lobehub:gateway:agent' },
            ),
          },
          { headers: { 'X-LobeHub-Gateway-Tenancy': '1', 'X-LobeHub-Tenant-Id': 'tenant-A' } },
        ),
      );
      await minter(send, { audience: 'urn:lobehub:gateway:agent', operationId: 'op' })({
        connectionId: 'tab-1',
        deviceId: 'ignored',
        signal: new AbortController().signal,
      });
      const body = JSON.parse(send.mock.calls[0][1].body);
      expect(body).toMatchObject({ audience: 'urn:lobehub:gateway:agent', connectionId: 'tab-1' });
      expect(body).not.toHaveProperty('deviceId');
    });
  });

  describe('enrollment attestation', () => {
    const attestation = (overrides: Record<string, unknown> = {}) => {
      const claims = {
        iss: 'urn:lobehub:gateway-session',
        aud: 'urn:lobehub:gateway:device',
        purpose: 'gateway-enrollment',
        tid: 'tenant-A',
        sub: 'sub',
        principal: { kind: 'workspace', id: 'ws' },
        accepted_version: 7,
        exp: Math.floor(Date.now() / 1000) + 300,
        ...overrides,
      };
      return `TEST.${btoa(JSON.stringify(claims)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')}.TEST`;
    };
    const workspaceIdentity = (tenantId = 'tenant-A', workspaceId = 'ws') =>
      identity({ tenantId, principal: { kind: 'workspace', id: workspaceId } });

    it('pins the tenant and workspace the identity must come back with', async () => {
      const ok = vi.fn(async () => reply(workspaceIdentity()));
      await expect(
        minter(ok, { initialTicket: attestation(), workspaceId: 'ws' })(input()),
      ).resolves.toMatchObject({ principal: { kind: 'workspace', id: 'ws' } });
      for (const wrong of [workspaceIdentity('tenant-B'), workspaceIdentity('tenant-A', 'other')]) {
        const send = vi.fn(async () => reply(wrong));
        await expect(
          minter(send, { initialTicket: attestation(), workspaceId: 'ws' })(input()),
        ).rejects.toThrow('GATEWAY_IDENTITY_CHANGED');
      }
    });

    it('is not a ticket and not accepted as one', () => {
      expect(() =>
        minter(vi.fn(), {
          initialTicket: attestation({ purpose: 'gateway-connect' }),
          workspaceId: 'ws',
        }),
      ).toThrow('GATEWAY_TENANCY_UNSUPPORTED');
    });
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';

import protocol from '../../../contracts/gateway-tenancy/v1/protocol.json';
import { GatewayHttpClient } from './http';

const tenantId = 'tenant-A';
const replyHeaders = { 'X-LobeHub-Gateway-Tenancy': '1', 'X-LobeHub-Tenant-Id': tenantId };
const methods = ['queryDeviceList', 'queryDeviceStatus'] as const;
const userId = 'user + &/?=中文';
const workspaceId = 'workspace + &/?=中文';
const device = {
  deviceId: 'same-device',
  channels: [{ channel: 'cli', connectionId: 'same-connection', connectedAt: 1 }],
};

const fixture = (options: { status?: number; headers?: Record<string, string> } = {}) => {
  const fetch = vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    const route = protocol.routes.find(
      (route) => route.service === 'device' && route.path === url.pathname,
    );
    // Match the frozen Go/ingress route table, rather than accepting every fetch.
    if (!route || route.method !== init?.method) return new Response(null, { status: 403 });
    if (!url.searchParams.has('userId') || init?.body !== undefined)
      return new Response(null, { status: 400 });
    return Response.json(
      { deviceCount: 1, devices: [device], online: true },
      { status: options.status ?? 200, headers: options.headers ?? replyHeaders },
    );
  });
  vi.stubGlobal('fetch', fetch);
  const prepareDispatch = vi.fn();
  const client = new GatewayHttpClient({
    gatewayUrl: 'https://gateway.invalid',
    serviceToken: 'TEST-SERVICE',
    tenantId,
    prepareDispatch,
  });
  return { client, fetch, prepareDispatch };
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('device reads follow the cross-language gateway contract', () => {
  it.each(methods)(
    '%s uses GET/query and preserves personal/workspace identity and strict prefix',
    async (method) => {
      const { fetch, prepareDispatch } = fixture();
      const deadline = vi.spyOn(AbortSignal, 'timeout');
      for (const base of ['https://gateway.invalid', 'https://gateway.invalid/tenant/v1/']) {
        const client = new GatewayHttpClient({
          gatewayUrl: base,
          serviceToken: 'TEST-SERVICE',
          tenantId,
          prepareDispatch,
        });
        for (const workspace of [undefined, workspaceId]) {
          const result = await client[method](userId, workspace);
          expect(result).toEqual(
            method === 'queryDeviceList' ? [device] : { deviceCount: 1, online: true },
          );
          const [input, init] = fetch.mock.calls.at(-1)!;
          const url = new URL(input);
          const route = protocol.routes.find(
            (route) => route.service === 'device' && route.path === url.pathname,
          );
          expect(route).toMatchObject({
            authority: 'service',
            executionVersion: false,
            method: 'GET',
          });
          expect(url.pathname).toBe(
            `/tenant/v1/api/device/${method === 'queryDeviceList' ? 'devices' : 'status'}`,
          );
          expect(url.searchParams.get('userId')).toBe(userId);
          expect(url.searchParams.get('workspaceId')).toBe(workspace ?? null);
          expect([...url.searchParams.keys()].sort()).toEqual(
            workspace ? ['userId', 'workspaceId'] : ['userId'],
          );
          expect(init).toMatchObject({
            method: 'GET',
            redirect: 'error',
            signal: expect.any(AbortSignal),
          });
          expect(init?.body).toBeUndefined();
          expect(Object.fromEntries(new Headers(init?.headers))).toEqual(
            Object.fromEntries(
              new Headers({
                ...replyHeaders,
                'Authorization': 'Bearer TEST-SERVICE',
                'Content-Type': 'application/json',
              }),
            ),
          );
        }
      }
      expect(deadline).toHaveBeenCalledWith(10_000);
      expect(prepareDispatch).not.toHaveBeenCalled();
    },
  );

  it.each(methods)(
    '%s rejects missing/malformed tenant before transport or dispatch',
    async (method) => {
      const { fetch, prepareDispatch } = fixture();
      for (const invalid of [undefined, '', 'tenant A', 'tenant-A,tenant-B', 't'.repeat(129)]) {
        const client = new GatewayHttpClient({
          gatewayUrl: 'https://gateway.invalid',
          serviceToken: 'TEST-SERVICE',
          tenantId: invalid,
          prepareDispatch,
        });
        await expect(client[method](userId)).rejects.toThrow('TENANT_HEADER_INVALID');
      }
      expect(fetch).not.toHaveBeenCalled();
      expect(prepareDispatch).not.toHaveBeenCalled();
    },
  );

  it.each(methods)(
    '%s rejects a success with mismatched tenant or missing/wrong protocol',
    async (method) => {
      for (const headers of [
        { ...replyHeaders, 'X-LobeHub-Tenant-Id': 'tenant-B' },
        { 'X-LobeHub-Tenant-Id': tenantId },
        { ...replyHeaders, 'X-LobeHub-Gateway-Tenancy': '2' },
      ]) {
        const { client } = fixture({ headers });
        await expect(client[method](userId)).rejects.toThrow('TENANT_MISMATCH');
      }
    },
  );

  it.each(methods)(
    '%s propagates failed reads instead of reporting devices offline',
    async (method) => {
      for (const status of [401, 403, 503]) {
        const { client } = fixture({ status });
        await expect(client[method](userId)).rejects.toThrow(`responded ${status}`);
      }
    },
  );

  it('still rejects malformed tenant before preparing an executable POST', async () => {
    const { fetch, prepareDispatch } = fixture();
    const client = new GatewayHttpClient({
      gatewayUrl: 'https://gateway.invalid',
      serviceToken: 'TEST-SERVICE',
      tenantId: 'tenant A',
      execution: { tenantId: 'tenant A', sourceAcceptedVersion: 7 },
      prepareDispatch,
    });
    await expect(client.invokeRpc({ userId }, { method: 'exec' })).rejects.toThrow(
      'TENANT_HEADER_INVALID',
    );
    expect(prepareDispatch).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});

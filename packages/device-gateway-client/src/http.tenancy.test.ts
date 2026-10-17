import { afterEach, describe, expect, it, vi } from 'vitest';

import { GatewayHttpClient } from './http';

const execution = { tenantId: 'tenant-A', sourceAcceptedVersion: 7 };
const intent = {
  ...execution,
  tenancyProtocol: 1 as const,
  actor: { subject: 'user', sourceRef: 'opaque' },
  targetPrincipal: { kind: 'user' as const, id: 'user' },
  action: 'device.rpc' as const,
  resourceId: 'device-A',
  attemptId: 'attempt-A',
  attemptExpiresAt: Date.now() + 30_000,
};
const headers = { 'X-LobeHub-Gateway-Tenancy': '1', 'X-LobeHub-Tenant-Id': 'tenant-A' };
afterEach(() => vi.unstubAllGlobals());
describe('strict device HTTP request and original result', () => {
  it('requires tenant, validates reply headers and preserves the strict prefix once', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('{"online":true,"deviceCount":1}', { headers })),
    );
    const client = new GatewayHttpClient({
      gatewayUrl: 'https://gw.invalid/tenant/v1/',
      serviceToken: 'TEST',
      ...execution,
      execution,
    });
    expect(await client.queryDeviceStatus('user')).toEqual({ online: true, deviceCount: 1 });
    expect(fetch).toHaveBeenCalledWith(
      'https://gw.invalid/tenant/v1/api/device/status',
      expect.objectContaining({ redirect: 'error', headers: expect.objectContaining(headers) }),
    );
    vi.mocked(fetch).mockResolvedValue(
      new Response('{"online":true}', {
        headers: { ...headers, 'X-LobeHub-Tenant-Id': 'tenant-B' },
      }),
    );
    await expect(client.queryDeviceStatus('user')).rejects.toThrow('TENANT_MISMATCH');
  });
  it('does not send an executable legacy request without a Work attempt', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const client = new GatewayHttpClient({
      gatewayUrl: 'https://gw.invalid',
      serviceToken: 'TEST',
      tenantId: 'tenant-A',
      execution,
    });
    await expect(client.invokeRpc({ userId: 'user' }, { method: 'exec' })).rejects.toThrow(
      'TENANT_EXECUTION_VERSION_REQUIRED',
    );
    expect(fetch).not.toHaveBeenCalled();
  });
  it('accepts only the original attempt result and unwraps its typed business result', async () => {
    const reply = {
      ...execution,
      attemptId: intent.attemptId,
      dispatchBinding: { authorizationId: 'auth', connectionId: 'actual', connectionGeneration: 3 },
      outcome: 'completed',
      result: { data: { ok: 1 }, success: true },
    };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify(reply), { headers })),
    );
    const client = new GatewayHttpClient({
      gatewayUrl: 'https://gw.invalid',
      serviceToken: 'TEST',
      tenantId: 'tenant-A',
      execution,
      prepareDispatch: async () => ({ ...execution, intent }),
    });
    expect(await client.invokeRpc({ userId: 'user' }, { method: 'exec' })).toEqual({
      data: { ok: 1 },
      error: undefined,
      success: true,
    });
    const sent = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
    expect(sent.intent).toEqual(intent);
    expect(sent.deviceId).toBe('device-A');
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ ...reply, attemptId: 'replacement' }), { headers }),
    );
    await expect(client.invokeRpc({ userId: 'user' }, { method: 'exec' })).rejects.toThrow(
      'ATTEMPT_CONFLICT',
    );
  });
  it.each([[null], [[]], ['invalid']])(
    'rejects a malformed response envelope: %j',
    async (reply) => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(new Response(JSON.stringify(reply), { headers })),
      );
      const client = new GatewayHttpClient({
        gatewayUrl: 'https://gw.invalid',
        serviceToken: 'TEST',
        ...execution,
        execution,
        prepareDispatch: async () => ({ ...execution, intent }),
      });
      await expect(client.invokeRpc({ userId: 'user' }, { method: 'exec' })).rejects.toThrow(
        'INVALID_GATEWAY_MESSAGE',
      );
    },
  );
  it.each([
    [null],
    [[]],
    [{ authorizationId: 'auth', connectionId: 'actual', connectionGeneration: '3' }],
  ])('rejects a malformed dispatch binding: %j', async (dispatchBinding) => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            ...execution,
            attemptId: intent.attemptId,
            dispatchBinding,
            outcome: 'completed',
            result: { success: true },
          }),
          { headers },
        ),
      ),
    );
    const client = new GatewayHttpClient({
      gatewayUrl: 'https://gw.invalid',
      serviceToken: 'TEST',
      ...execution,
      execution,
      prepareDispatch: async () => ({ ...execution, intent }),
    });
    await expect(client.invokeRpc({ userId: 'user' }, { method: 'exec' })).rejects.toThrow(
      'ATTEMPT_CONFLICT',
    );
  });
});

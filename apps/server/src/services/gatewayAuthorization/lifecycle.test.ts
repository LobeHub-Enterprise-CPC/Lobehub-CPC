import { afterEach, describe, expect, it, vi } from 'vitest';

import { closeGatewayRealtime } from './lifecycle';

vi.mock('@/envs/app', () => ({
  appEnv: {
    AGENT_GATEWAY_INTERNAL_URL: 'http://agent.invalid/tenant/v1',
    AGENT_GATEWAY_SERVICE_TOKEN: 'TEST-AGENT',
  },
}));
vi.mock('@/envs/gateway', () => ({
  gatewayEnv: {
    DEVICE_GATEWAY_URL: 'http://device.invalid',
    DEVICE_GATEWAY_SERVICE_TOKEN: 'TEST-DEVICE',
  },
}));

const context = { tenantId: 'tenant-A', eventId: 'claimed-event', acceptedVersion: 9 };
const ack = {
  tenantId: 'tenant-A',
  acceptedVersion: 9,
  outcome: 'fenced-and-closed',
  cancelledBeforeDispatch: 2,
  executionUnknown: 1,
};
const response = (body = ack, tenant = 'tenant-A') =>
  new Response(JSON.stringify(body), {
    headers: { 'X-LobeHub-Gateway-Tenancy': '1', 'X-LobeHub-Tenant-Id': tenant },
  });
afterEach(() => vi.unstubAllGlobals());
describe('actual dual-gateway lifecycle acknowledgment', () => {
  it('uses the claimed context and accepts the frozen ack shape from both configured services', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => response()),
    );
    await closeGatewayRealtime(context);
    expect(fetch).toHaveBeenCalledTimes(2);
    for (const [url, request] of vi.mocked(fetch).mock.calls) {
      expect(String(url)).toMatch(
        /^http:\/\/(agent|device)\.invalid\/tenant\/v1\/api\/control\/tenant-suspend$/,
      );
      expect(request?.redirect).toBe('error');
      expect(JSON.parse(request?.body as string)).toEqual({ tenancyProtocol: 1, ...context });
      expect(request?.headers).toMatchObject({ 'X-LobeHub-Tenant-Version': '9' });
    }
  });
  it.each([() => response({ ...ack, acceptedVersion: 10 }), () => response(ack, 'tenant-B')])(
    'rejects a mismatched acknowledgment',
    async (bad) => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementation(async () => bad()),
      );
      await expect(closeGatewayRealtime(context)).rejects.toMatchObject({
        code: 'LIFECYCLE_STOP_FAILED',
      });
    },
  );
  it('fails if one configured service is unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (url) => {
        if (String(url).includes('device.invalid')) throw new Error('unreachable');
        return response();
      }),
    );
    await expect(closeGatewayRealtime(context)).rejects.toThrow('unreachable');
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

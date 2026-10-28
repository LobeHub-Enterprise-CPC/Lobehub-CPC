import type * as DeviceGatewayClient from '@lobechat/device-gateway-client';
import { getTRPCErrorFromUnknown } from '@trpc/server';
import { getHTTPStatusCodeFromError } from '@trpc/server/http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DeviceGateway } from './index';

const boundary = vi.hoisted(() => ({ client: vi.fn(), invokeRpc: vi.fn(), tenancy: vi.fn() }));
const env = vi.hoisted(() => ({
  DEVICE_GATEWAY_SERVICE_TOKEN: undefined as string | undefined,
  DEVICE_GATEWAY_URL: undefined as string | undefined,
}));
vi.mock('@lobechat/device-gateway-client', async (importOriginal) => ({
  ...(await importOriginal<typeof DeviceGatewayClient>()),
  GatewayHttpClient: boundary.client.mockImplementation(function () {
    return boundary;
  }),
}));
vi.mock('@/envs/gateway', () => ({ gatewayEnv: env }));
vi.mock('@/server/services/redis', () => ({ redisService: {} }));
vi.mock('./tenancy', () => ({ deviceGatewayTenancy: boundary.tenancy }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', vi.fn());
});
afterEach(() => vi.unstubAllGlobals());

describe.each([false, true])('disabled port discovery (gateway configured: %s)', (configured) => {
  it.each([undefined, 'workspace-1'])(
    'refuses scope %s before client, tenancy or RPC',
    async (workspaceId) => {
      env.DEVICE_GATEWAY_URL = configured ? 'https://gateway.test' : undefined;
      env.DEVICE_GATEWAY_SERVICE_TOKEN = configured ? 'fixture-token' : undefined;
      const error = await new DeviceGateway()
        .listListeningPorts({
          cwd: '/fixture',
          deviceId: 'device-1',
          userId: 'user-1',
          workspaceId,
        })
        .then(
          () => undefined,
          (cause: unknown) => getTRPCErrorFromUnknown(cause),
        );

      expect(error).toBeDefined();
      expect(error?.code).toBe('NOT_IMPLEMENTED');
      expect(error?.message).toBe('TUNNEL_UNSUPPORTED');
      expect(getHTTPStatusCodeFromError(error!)).toBe(501);
      for (const spy of Object.values(boundary)) expect(spy).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    },
  );
});

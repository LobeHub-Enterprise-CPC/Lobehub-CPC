import type * as DeviceGatewayClient from '@lobechat/device-gateway-client';
import { getTRPCErrorFromUnknown } from '@trpc/server';
import { getHTTPStatusCodeFromError } from '@trpc/server/http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DeviceTunnelRegistry } from './tunnels';

const boundary = vi.hoisted(() => ({
  client: vi.fn(),
  createTunnel: vi.fn(),
  listTunnels: vi.fn(),
  resolveTunnel: vi.fn(),
  revokeTunnel: vi.fn(),
}));
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

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', vi.fn());
});
afterEach(() => vi.unstubAllGlobals());

// These are the four router consumption paths: openTunnel first lists links,
// so a disabled registry must reject before the caller can mint an access token.
describe.each([false, true])('disabled tunnels (gateway configured: %s)', (configured) => {
  describe.each([undefined, 'workspace-1'])('scope %s', (workspaceId) => {
    it.each(['createTunnel', 'listTunnels', 'openTunnel', 'revokeTunnel'] as const)(
      'refuses %s before effects',
      async (entry) => {
        env.DEVICE_GATEWAY_URL = configured ? 'https://gateway.test' : undefined;
        env.DEVICE_GATEWAY_SERVICE_TOKEN = configured ? 'fixture-token' : undefined;
        const registry = new DeviceTunnelRegistry();
        const principal = { userId: 'user-1', workspaceId };
        const mintAccessToken = vi.fn();
        const calls = {
          createTunnel: () => registry.create({ ...principal, deviceId: 'device-1', port: 3000 }),
          listTunnels: () => registry.list(principal),
          openTunnel: async () => {
            const links = await registry.list(principal);
            return mintAccessToken(links[0]);
          },
          revokeTunnel: () => registry.revoke({ ...principal, slug: 'abcdefgh' }),
        };

        const error = await calls[entry]().then(
          () => undefined,
          (cause: unknown) => getTRPCErrorFromUnknown(cause),
        );
        expect(error, entry).toBeDefined();
        expect(getHTTPStatusCodeFromError(error!), entry).toBe(501);
        expect(error?.code, entry).toBe('NOT_IMPLEMENTED');
        expect(error?.message, entry).toBe('TUNNEL_UNSUPPORTED');

        for (const spy of Object.values(boundary)) expect(spy).not.toHaveBeenCalled();
        expect(fetch).not.toHaveBeenCalled();
        expect(mintAccessToken).not.toHaveBeenCalled();
      },
    );
  });
});

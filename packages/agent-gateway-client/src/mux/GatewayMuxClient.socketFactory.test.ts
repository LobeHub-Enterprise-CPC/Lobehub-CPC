import { afterEach, expect, it, vi } from 'vitest';

import { GatewayMuxClient } from './GatewayMuxClient';

afterEach(() => vi.unstubAllGlobals());
it('uses an optional socket factory on each dial without constructing a global socket', async () => {
  const native = vi.fn();
  vi.stubGlobal('WebSocket', native);
  const socket = { close: vi.fn(), readyState: 0, onmessage: null, onclose: null, onerror: null };
  const createWebSocket = vi.fn(() => socket as unknown as WebSocket);
  const mux = new GatewayMuxClient({
    gatewayUrl: 'https://gw',
    getToken: async () => 'token',
    createWebSocket,
  });
  const connected = mux.connect().catch(() => {});
  await Promise.resolve();
  expect(createWebSocket).toHaveBeenCalledWith(expect.stringContaining('wss://gw/v2/ws?'));
  expect(native).not.toHaveBeenCalled();
  mux.disconnect();
  await connected;
  const next = mux.connect().catch(() => {});
  await Promise.resolve();
  expect(createWebSocket).toHaveBeenCalledTimes(2);
  mux.disconnect();
  await next;
});

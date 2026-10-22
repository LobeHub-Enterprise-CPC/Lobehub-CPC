import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { aiAgentService } from '@/services/aiAgent';

import { getGatewayMux, resetGatewayMuxRegistry } from './muxRegistry';

vi.mock('@/services/aiAgent', () => ({
  aiAgentService: { issueGatewayUserToken: vi.fn() },
}));

/** Never opens: enough for `connect()` to get past `getToken`. */
class InertWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  readyState = InertWebSocket.CONNECTING;
  onopen = null;
  onmessage = null;
  onclose = null;
  onerror = null;
  constructor(public url: string) {}
  send() {}
  close() {
    this.readyState = InertWebSocket.CLOSED;
  }
}

const GATEWAY_URL = 'https://gateway.test.com';
const flushMicrotasks = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('muxRegistry', () => {
  beforeEach(() => {
    vi.stubGlobal('WebSocket', InertWebSocket);
    vi.mocked(aiAgentService.issueGatewayUserToken).mockResolvedValue({ token: 'owner-jwt' });
  });

  afterEach(() => {
    resetGatewayMuxRegistry();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('returns one mux per gatewayUrl', () => {
    const owner = getGatewayMux({ gatewayUrl: GATEWAY_URL });
    expect(getGatewayMux({ gatewayUrl: GATEWAY_URL })).toBe(owner);
    expect(getGatewayMux({ gatewayUrl: 'https://other.test.com' })).not.toBe(owner);
  });

  it('mints an owner user token for the owner mux', async () => {
    const owner = getGatewayMux({ gatewayUrl: GATEWAY_URL });
    void owner.connect().catch(() => {});
    await flushMicrotasks();

    expect(aiAgentService.issueGatewayUserToken).toHaveBeenCalledTimes(1);
  });

  it('reset disconnects every mux and forgets it', () => {
    const owner = getGatewayMux({ gatewayUrl: GATEWAY_URL });
    const disconnect = vi.spyOn(owner, 'disconnect');

    resetGatewayMuxRegistry();

    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(getGatewayMux({ gatewayUrl: GATEWAY_URL })).not.toBe(owner);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { aiAgentService } from '@/services/aiAgent';
import { getLlmRelayClientId } from '@/services/llmRelay/clientId';

import { getGatewayMux, isGatewayMuxUnavailable, resetGatewayMuxRegistry } from './muxRegistry';

const state = vi.hoisted(() => ({ tenant: 'tenant-A', user: 'user-A' }));
vi.mock('@lobechat/business-tenant/client', () => ({ getTenantScopeId: () => state.tenant }));
vi.mock('@/store/user', () => ({ getUserStoreState: () => ({ user: state.user }) }));
vi.mock('@/store/user/selectors', () => ({ userProfileSelectors: { userId: () => state.user } }));
vi.mock('@/services/aiAgent', () => ({ aiAgentService: { issueGatewayUserToken: vi.fn() } }));

class Socket {
  static OPEN = 1;
  static CLOSED = 3;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose = null;
  onerror = null;
  sent: Record<string, unknown>[] = [];
  constructor(public url: string) {
    sockets.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
  }
}
const sockets: Socket[] = [];
const GATEWAY_URL = 'https://gateway.test.com';
const token = (expiresAt: number) =>
  `header.${btoa(
    JSON.stringify({
      iss: 'urn:lobehub:gateway-session',
      purpose: 'gateway-connect',
      aud: 'urn:lobehub:gateway:agent',
      tid: state.tenant,
      sub: state.user,
      principal: { kind: 'user', id: state.user },
      capabilities: ['agent:observe'],
      accepted_version: 7,
      authorization_id: 'authorization',
      connection_id: getLlmRelayClientId(),
      exp: Math.floor(expiresAt / 1000),
    }),
  )}.signature`;

describe('muxRegistry', () => {
  beforeEach(() => {
    state.tenant = 'tenant-A';
    state.user = 'user-A';
    vi.stubGlobal('WebSocket', Socket);
    vi.useFakeTimers();
    vi.setSystemTime(1900000000000);
    vi.mocked(aiAgentService.issueGatewayUserToken).mockImplementation(async () => ({
      token: token(Date.now() + 10000),
    }));
  });
  afterEach(() => {
    resetGatewayMuxRegistry();
    vi.clearAllTimers();
    vi.useRealTimers();
    sockets.length = 0;
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });
  it('partitions muxes by URL, tenant and signed-in user', () => {
    const owner = getGatewayMux({ gatewayUrl: GATEWAY_URL });
    expect(getGatewayMux({ gatewayUrl: GATEWAY_URL })).toBe(owner);
    expect(getGatewayMux({ gatewayUrl: 'https://other.test' })).not.toBe(owner);
    state.tenant = 'tenant-B';
    expect(getGatewayMux({ gatewayUrl: GATEWAY_URL })).not.toBe(owner);
    state.tenant = 'tenant-A';
    state.user = 'user-B';
    expect(getGatewayMux({ gatewayUrl: GATEWAY_URL })).not.toBe(owner);
  });
  it('sends the per-tab client ID and original authorization on in-socket renewal', async () => {
    const mux = getGatewayMux({ gatewayUrl: GATEWAY_URL });
    const connected = mux.connect().catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(aiAgentService.issueGatewayUserToken).toHaveBeenCalledWith({
      clientId: getLlmRelayClientId(),
    });
    sockets[0].onopen?.();
    sockets[0].onmessage?.({
      data: JSON.stringify({
        type: 'auth_success',
        tenancyProtocol: 1,
        tenantId: state.tenant,
        principal: { kind: 'user', id: state.user },
        audience: 'urn:lobehub:gateway:agent',
        roles: ['agent:observe'],
        acceptedVersion: 7,
        connectionGeneration: 1,
        ticketExpiresAt: Date.now() + 10000,
        authRecordExpiresAt: Date.now() + 10000,
        leaseExpiresAt: Date.now() + 10000,
      }),
    });
    await vi.advanceTimersByTimeAsync(5000);
    expect(aiAgentService.issueGatewayUserToken).toHaveBeenLastCalledWith({
      clientId: getLlmRelayClientId(),
      authorizationId: 'authorization',
    });
    mux.disconnect();
    await connected;
  });
  it('marks a failed warmup identity unavailable even without a run listener', async () => {
    vi.mocked(aiAgentService.issueGatewayUserToken).mockRejectedValue(new Error('MUX_UNSUPPORTED'));
    const mux = getGatewayMux({ gatewayUrl: GATEWAY_URL });
    const failed = mux.connect().catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(10000);
    expect(await failed).toEqual(
      expect.objectContaining({ message: expect.stringContaining('unavailable') }),
    );
    expect(isGatewayMuxUnavailable({ gatewayUrl: GATEWAY_URL })).toBe(true);
    state.tenant = 'tenant-B';
    expect(isGatewayMuxUnavailable({ gatewayUrl: GATEWAY_URL })).toBe(false);
  });
  it('does not mint for a stale account and marks only that captured identity unavailable', async () => {
    const identity = { gatewayUrl: GATEWAY_URL, tenantId: state.tenant, userId: state.user };
    const mux = getGatewayMux(identity);
    state.user = 'user-B';
    const failed = mux.connect().catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(10000);
    expect(await failed).toBeInstanceOf(Error);
    expect(aiAgentService.issueGatewayUserToken).not.toHaveBeenCalled();
    expect(isGatewayMuxUnavailable(identity)).toBe(true);
    expect(isGatewayMuxUnavailable({ gatewayUrl: GATEWAY_URL })).toBe(false);
  });

  it('reset disconnects and forgets every mux and unavailable identity', () => {
    const mux = getGatewayMux({ gatewayUrl: GATEWAY_URL });
    const disconnect = vi.spyOn(mux, 'disconnect');
    resetGatewayMuxRegistry();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(getGatewayMux({ gatewayUrl: GATEWAY_URL })).not.toBe(mux);
    expect(isGatewayMuxUnavailable({ gatewayUrl: GATEWAY_URL })).toBe(false);
  });
});

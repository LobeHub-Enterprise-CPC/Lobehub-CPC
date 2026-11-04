import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { App } from '@/core/App';

import GatewayConnectionService from './gatewayConnectionSrv';

const sockets = vi.hoisted(() => ({ constructs: 0, reconnects: 0 }));
vi.mock('@lobechat/device-gateway-client', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    GatewayClient: class extends EventEmitter {
      constructor() {
        super();
        sockets.constructs++;
      }
      async connect() {}
      async disconnect() {
        this.emit('status_changed', 'disconnected');
      }
      async reconnect() {
        sockets.reconnects++;
      }
    },
  };
});

vi.mock('electron', () => ({
  app: { getVersion: () => '0-test' },
  powerSaveBlocker: { start: vi.fn(() => 1), stop: vi.fn() },
}));

const identity = { gatewayTicket: 'TEST-TICKET', userId: 'same-sub' };

/** A tenant login whose identity provider is built by `factory` on every connect. */
const tenantService = (factory: () => Promise<unknown>) => {
  const service = new GatewayConnectionService({
    browserManager: { broadcastToAllWindows: vi.fn() },
    storeManager: { get: vi.fn(), set: vi.fn() },
  } as unknown as App);
  vi.spyOn(service as any, 'resolveDeviceIdentity').mockResolvedValue({
    deviceId: 'device-derived',
    identitySource: 'machine-id',
  });
  vi.spyOn(service as any, 'getConnectionId').mockReturnValue('connection-of-this-install');
  vi.spyOn(service as any, 'resolveEndpoint').mockResolvedValue({
    endpoint: { source: 'advertised', url: 'https://gateway.invalid' },
  });
  service.setServerUrlProvider(async () => 'https://server.invalid');
  service.setTokenProvider(async () => 'login-token');
  service.setIdentityProviderFactory(factory as never);
  return service;
};

const providerOf = (...results: Array<Error | typeof identity>) => {
  const provider = vi.fn(async () => {
    const next = results.length > 1 ? results.shift()! : results[0];
    if (next instanceof Error) throw next;
    return next;
  });
  return Object.assign(provider, { subject: 'same-sub' });
};

beforeEach(() => {
  vi.useFakeTimers();
  sockets.constructs = 0;
  sockets.reconnects = 0;
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('desktop tenant gateway recovery', () => {
  it('does not announce a terminal outage while rebuilding a rejected tenant login', async () => {
    const service = tenantService(async () => providerOf(identity));
    await service.connect();
    const broadcast = vi.mocked((service as any).app.browserManager.broadcastToAllWindows);
    broadcast.mockClear();
    const client = (service as any).client;
    await client.disconnect();
    client.emit('auth_failed', 'UNAUTHORIZED');
    await vi.advanceTimersByTimeAsync(0);
    expect(broadcast.mock.calls.map((call: any[]) => call[1].status)).not.toContain('disconnected');
    await service.disconnect();
  });
  it('retries a temporary failure while building the identity provider', async () => {
    const factory = vi
      .fn()
      .mockRejectedValueOnce(new Error('net::ERR_INTERNET_DISCONNECTED'))
      .mockResolvedValue(providerOf(identity));
    const service = tenantService(factory);
    await service.connect();
    expect(service.getDisplayedState()).toEqual({ status: 'reconnecting' });
    await vi.advanceTimersByTimeAsync(5000);
    expect(factory).toHaveBeenCalledTimes(2);
    expect(sockets.constructs).toBe(1);
  });

  it('preserves an authorization refusal instead of calling a signed-in account signed out', async () => {
    const service = tenantService(async () => providerOf(new Error('FORBIDDEN')));
    await service.connect();
    expect(service.getDisplayedState()).toEqual({
      status: 'disconnected',
      error: { code: 'auth_failed', detail: 'FORBIDDEN' },
    });
  });

  it('retries failed gateway discovery without waiting for another app start', async () => {
    const service = tenantService(async () => providerOf(identity));
    vi.mocked((service as any).resolveEndpoint).mockResolvedValueOnce({
      ok: false,
      reason: 'discovery_failed',
      detail: 'HTTP 503',
    });
    await service.connect();
    expect(service.getStatus()).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(5000);
    expect(sockets.constructs).toBe(1);
  });

  it.each(['HTTP 404', 'the response is not JSON'])(
    'stops discovery retries for %s',
    async (detail) => {
      const service = tenantService(async () => providerOf(identity));
      const discover = vi.mocked((service as any).resolveEndpoint).mockResolvedValue({
        ok: false,
        reason: 'discovery_failed',
        detail,
      });
      await service.connect();
      await vi.advanceTimersByTimeAsync(300_000);
      expect(service.getDisplayedState()).toMatchObject({
        status: 'disconnected',
        error: { code: 'config_unavailable' },
      });
      expect(discover).toHaveBeenCalledOnce();
    },
  );

  it('bounds the UI grace period across repeated connection phases', async () => {
    const service = tenantService(async () => providerOf(identity));
    (service as any).setStatus('connected');
    (service as any).setStatus('reconnecting');
    await vi.advanceTimersByTimeAsync(2000);
    (service as any).setStatus('connecting');
    await vi.advanceTimersByTimeAsync(2000);
    (service as any).setStatus('authenticating');
    await vi.advanceTimersByTimeAsync(1000);
    expect(service.getDisplayedStatus()).toBe('authenticating');
    await service.disconnect();
  });

  // Windows wakes (or starts at sign-in) before the network is back: the first
  // ticket request fails offline, and nothing else would ever connect again.
  it('retries the first ticket after an offline failure instead of giving up', async () => {
    const provider = providerOf(new Error('net::ERR_INTERNET_DISCONNECTED'), identity);
    const service = tenantService(async () => provider);

    await expect(service.connect()).resolves.toMatchObject({ success: false });
    expect(service.getStatus()).toBe('reconnecting');
    expect(sockets.constructs).toBe(0);

    await vi.advanceTimersByTimeAsync(5000);
    expect(provider).toHaveBeenCalledTimes(2);
    expect(sockets.constructs).toBe(1);
  });

  it('keeps backing off while the network stays down', async () => {
    const provider = providerOf(new Error('net::ERR_NAME_NOT_RESOLVED'));
    const service = tenantService(async () => provider);
    await service.connect();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    // 5s, 10s, 20s, 40s, then every 60s: bounded, but never abandoned.
    expect(provider.mock.calls.length).toBeGreaterThanOrEqual(6);
    expect(provider.mock.calls.length).toBeLessThan(15);
    expect(service.getStatus()).toBe('reconnecting');
  });

  it('settles on disconnected without retrying when the ticket is refused', async () => {
    const provider = providerOf(new Error('FORBIDDEN'));
    const service = tenantService(async () => provider);
    await service.connect();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(provider).toHaveBeenCalledOnce();
    expect(service.getStatus()).toBe('disconnected');
  });

  it('drops a scheduled retry when the device is turned off', async () => {
    const provider = providerOf(new Error('net::ERR_INTERNET_DISCONNECTED'), identity);
    const service = tenantService(async () => provider);
    await service.connect();
    await service.disconnect();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(provider).toHaveBeenCalledOnce();
    expect(sockets.constructs).toBe(0);
    expect(service.getStatus()).toBe('disconnected');
  });

  // The provider carries the access token it was built with, so a rejected
  // ticket may only mean that token went stale: one fresh login attempt, then
  // the rejection is final.
  it('rebuilds the login once after the gateway rejects it, then stops', async () => {
    const factory = vi.fn(async () => providerOf(identity));
    const service = tenantService(factory);
    await service.connect();
    expect(factory).toHaveBeenCalledOnce();

    await (service as any).handleAuthFailed((service as any).client, 'UNAUTHORIZED');
    expect(factory).toHaveBeenCalledTimes(2);
    expect(sockets.constructs).toBe(2);

    await (service as any).handleAuthFailed((service as any).client, 'UNAUTHORIZED');
    expect(factory).toHaveBeenCalledTimes(2);
    expect(service.getStatus()).toBe('disconnected');
  });

  // After sleep the old socket may look alive for up to ~2 minutes of missed
  // heartbeats; waking reconnects it at once.
  it('reconnects the live connection on wake', async () => {
    const service = tenantService(async () => providerOf(identity));
    await service.connect();
    expect(service.reconnectAfterWake()).toBe(true);
    expect(sockets.reconnects).toBe(1);
  });

  it('reports that there is nothing to wake when no connection exists', () => {
    const service = tenantService(async () => providerOf(identity));
    expect(service.reconnectAfterWake()).toBe(false);
  });
});

import type { EventEmitter } from 'node:events';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { gatewayIdentityHint } from '../../agent-gateway-client/src/tenancy';
import { deviceConfirmation, deviceTicket } from './__tests__/fixtures';
import { GatewayClient } from './client';

const sockets = vi.hoisted(() => [] as any[]);
vi.mock('ws', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    default: class Socket extends EventEmitter {
      static OPEN = 1;
      static CONNECTING = 0;
      readyState = 1;
      send = vi.fn();
      close = vi.fn(() => {
        this.readyState = 3;
      });
      constructor() {
        super();
        sockets.push(this);
      }
    },
  };
});
const clients: GatewayClient[] = [];
const identity = () => gatewayIdentityHint(deviceTicket(), 'urn:lobehub:gateway:device');
const create = (provider: any, autoReconnect = true) => {
  const client = new GatewayClient({
    gatewayUrl: 'https://gw.invalid',
    token: 'TEST-ONLY',
    userId: 'test-user',
    identityProvider: provider,
    autoReconnect,
  });
  clients.push(client);
  return client;
};
const confirm = (socket: EventEmitter, data: Record<string, unknown> = {}) =>
  socket.emit('message', Buffer.from(JSON.stringify({ ...deviceConfirmation(), ...data })));
beforeEach(() => {
  vi.useFakeTimers();
  sockets.length = 0;
});
afterEach(async () => {
  for (const client of clients.splice(0)) await client.disconnect();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
describe('owning device identity provider lifecycle', () => {
  it.each([
    'SOURCE_UNVERIFIABLE',
    'UNAUTHORIZED',
    'FORBIDDEN',
    'GATEWAY_TENANCY_UNSUPPORTED',
    'TENANT_MISMATCH',
    'TENANT_EXECUTION_VERSION_STALE',
  ])('terminates %s observably without retry', async (code) => {
    const provider = vi.fn().mockRejectedValue(new Error(code));
    const client = create(provider);
    const rejected = vi.fn();
    client.on('auth_failed', rejected);
    await client.connect();
    await vi.advanceTimersByTimeAsync(5000);
    expect(rejected).toHaveBeenCalledOnce();
    expect(rejected).toHaveBeenCalledWith(code);
    expect(provider).toHaveBeenCalledOnce();
    expect(sockets).toHaveLength(0);
  });
  it.each([
    [401, 'UNAUTHORIZED'],
    [403, 'FORBIDDEN'],
    [426, 'GATEWAY_TENANCY_UNSUPPORTED'],
    [501, 'GATEWAY_TENANCY_UNSUPPORTED'],
  ])('reports HTTP %s as terminal %s', async (status, code) => {
    const provider = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('identity denied'), { status }));
    const client = create(provider);
    const failed = vi.fn();
    client.on('auth_failed', failed);
    await client.connect();
    await vi.advanceTimersByTimeAsync(5000);
    expect(failed).toHaveBeenCalledWith(code);
    expect(provider).toHaveBeenCalledOnce();
  });
  it('stops retrying an incompatible WebSocket upgrade', async () => {
    const provider = vi.fn(async () => identity());
    const client = create(provider);
    const failed = vi.fn();
    client.on('auth_failed', failed);
    await client.connect();
    await vi.advanceTimersByTimeAsync(0);
    sockets[0].emit('error', new Error('Unexpected server response: 426'));
    await vi.advanceTimersByTimeAsync(5000);
    expect(failed).toHaveBeenCalledWith('GATEWAY_TENANCY_UNSUPPORTED');
    expect(provider).toHaveBeenCalledOnce();
  });
  it('keeps a temporary provider 503 retryable', async () => {
    const provider = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('temporarily unavailable'), { status: 503 }));
    const client = create(provider);
    const failed = vi.fn();
    client.on('auth_failed', failed);
    client.on('error', vi.fn());
    await client.connect();
    await vi.advanceTimersByTimeAsync(1000);
    expect(provider).toHaveBeenCalledTimes(2);
    expect(failed).not.toHaveBeenCalled();
  });
  it('reports incompatibility even with autoReconnect disabled', async () => {
    const client = create(async () => {
      throw new Error('GATEWAY_TENANCY_UNSUPPORTED');
    }, false);
    const rejected = vi.fn();
    client.on('auth_failed', rejected);
    await client.connect();
    await vi.advanceTimersByTimeAsync(0);
    expect(rejected).toHaveBeenCalledWith('GATEWAY_TENANCY_UNSUPPORTED');
  });
  it('keeps network failures retryable', async () => {
    const provider = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' }),
      )
      .mockImplementation(async () => identity());
    const client = create(provider);
    const rejected = vi.fn();
    client.on('auth_failed', rejected);
    client.on('error', vi.fn());
    await client.connect();
    await vi.advanceTimersByTimeAsync(1000);
    expect(provider).toHaveBeenCalledTimes(2);
    expect(rejected).not.toHaveBeenCalled();
  });
  it('ignores a late provider rejection after disconnect', async () => {
    let reject!: (reason: Error) => void;
    const client = create(
      () =>
        new Promise((_resolve, deny) => {
          reject = deny;
        }),
    );
    const failed = vi.fn();
    client.on('auth_failed', failed);
    await client.connect();
    await client.disconnect();
    reject(new Error('SOURCE_UNVERIFIABLE'));
    await vi.advanceTimersByTimeAsync(5000);
    expect(failed).not.toHaveBeenCalled();
    expect(sockets).toHaveLength(0);
  });
  it('renews proactively at the midpoint on the same socket and accepts generation+1', async () => {
    const now = Date.now();
    const first = { ...identity(), ticketExpiresAt: now + 10000, authRecordExpiresAt: now + 10000 };
    const next = {
      ...first,
      gatewayTicket: 'TEST-ONLY-RENEWED',
      ticketExpiresAt: now + 20000,
      authRecordExpiresAt: now + 20000,
    };
    const provider = vi.fn().mockResolvedValueOnce(first).mockResolvedValue(next);
    const client = create(provider);
    client.on('error', vi.fn());
    await client.connect();
    await vi.advanceTimersByTimeAsync(0);
    const socket = sockets[0];
    socket.emit('open');
    confirm(socket, {
      ticketExpiresAt: first.ticketExpiresAt,
      authRecordExpiresAt: first.authRecordExpiresAt,
    });
    await vi.advanceTimersByTimeAsync(5000);
    expect(provider).toHaveBeenCalledTimes(2);
    expect(provider.mock.calls[1][0].renewAuthorizationId).toBe(first.authorizationId);
    expect(sockets).toHaveLength(1);
    expect(JSON.parse(socket.send.mock.calls.at(-1)[0])).toMatchObject({
      type: 'auth',
      token: next.gatewayTicket,
      tenancyProtocol: 1,
    });
    confirm(socket, {
      connectionGeneration: 2,
      ticketExpiresAt: next.ticketExpiresAt,
      authRecordExpiresAt: next.authRecordExpiresAt,
    });
    expect(client.connectionStatus).toBe('connected');
  });
});

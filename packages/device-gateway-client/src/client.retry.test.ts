import type { EventEmitter } from 'node:events';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import protocol from '../../../contracts/gateway-tenancy/v1/protocol.json';
import { gatewayIdentityHint } from '../../agent-gateway-client/src/tenancy';
import { deviceConfirmation, deviceTicket } from './__tests__/fixtures';
import { GatewayClient } from './client';

interface TestSocket extends EventEmitter {
  url: string;
}
const sockets = vi.hoisted(() => [] as TestSocket[]);
vi.mock('ws', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    default: class extends EventEmitter {
      static OPEN = 1;
      static CONNECTING = 0;
      readyState = 1;
      send = vi.fn();
      close = vi.fn();
      constructor(public url: string) {
        super();
        sockets.push(this);
      }
    },
  };
});
let client: GatewayClient;
const latest = () => sockets.at(-1)!;
const receive = (frame: unknown) => latest().emit('message', Buffer.from(JSON.stringify(frame)));
const create = (autoReconnect = true) => {
  client = new GatewayClient({ token: deviceTicket(), autoReconnect });
  return client;
};
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(1);
  sockets.length = 0;
});
afterEach(async () => {
  await client?.disconnect();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('device gateway rejection recovery', () => {
  it('honors disconnect from a reconnecting listener', async () => {
    create();
    client.on('reconnecting', () => void client.disconnect());
    await client.connect();
    latest().emit('close', 1006, Buffer.from(''));
    await vi.advanceTimersByTimeAsync(5000);
    expect(sockets).toHaveLength(1);
    expect(client.connectionStatus).toBe('disconnected');
  });

  it('jitters transient reconnects within the capped exponential budget', async () => {
    vi.mocked(Math.random).mockReturnValue(0.25);
    create();
    const retry = vi.fn();
    client.on('reconnecting', retry);
    await client.connect();
    for (const budget of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
      latest().emit('close', 1006, Buffer.from(''));
      const delay = retry.mock.calls.at(-1)![0];
      expect(delay).toBe(budget * 0.625);
      await vi.advanceTimersByTimeAsync(delay);
    }
  });

  it('re-mints on expiry with the same connectionId', async () => {
    const identity = gatewayIdentityHint(deviceTicket(), 'urn:lobehub:gateway:device');
    const provider = vi
      .fn()
      .mockResolvedValueOnce(identity)
      .mockResolvedValue({ ...identity, gatewayTicket: 'fresh-ticket' });
    client = new GatewayClient({ token: deviceTicket(), identityProvider: provider });
    await client.connect();
    const id = new URL(latest().url).searchParams.get('connectionId');
    receive({ type: 'auth_expired' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(provider).toHaveBeenCalledTimes(2);
    expect(provider.mock.calls[1][0]).toMatchObject({
      connectionId: id,
      renewAuthorizationId: identity.authorizationId,
    });
    expect(new URL(latest().url).searchParams.get('connectionId')).toBe(id);
  });

  it('stops on a policy close without an error frame', async () => {
    create();
    const failed = vi.fn();
    client.on('auth_failed', failed);
    await client.connect();
    latest().emit('close', 1008, Buffer.from('TENANT_FROZEN'));
    await vi.advanceTimersByTimeAsync(5000);
    expect(sockets).toHaveLength(1);
    expect(failed).toHaveBeenCalledWith('TENANT_FROZEN');
  });

  it('re-mints after local expiry and aborts a stalled renewal', async () => {
    const identity = gatewayIdentityHint(deviceTicket(), 'urn:lobehub:gateway:device');
    const first = { ...identity, ticketExpiresAt: Date.now() + 2000 };
    const provider = vi
      .fn()
      .mockResolvedValueOnce(first)
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValue(identity);
    client = new GatewayClient({ token: deviceTicket(), identityProvider: provider });
    await client.connect();
    latest().emit('open');
    receive({ ...deviceConfirmation(), ticketExpiresAt: first.ticketExpiresAt });
    await vi.advanceTimersByTimeAsync(3000);
    expect(provider).toHaveBeenCalledTimes(3);
    expect(provider.mock.calls[1][0].signal.aborted).toBe(true);
    expect(sockets).toHaveLength(2);
    expect(provider.mock.calls[2][0].connectionId).toBe(provider.mock.calls[0][0].connectionId);
  });

  it.each(Object.entries(protocol.errors))(
    '%s follows the frozen retry policy',
    async (code, entry) => {
      create();
      const failed = vi.fn();
      client.on('auth_failed', failed);
      await client.connect();
      latest().emit('open');
      receive({
        type: entry.wsEvent,
        code,
        retryable: entry.retryable,
        reason: 'human-readable detail',
      });
      await vi.advanceTimersByTimeAsync(1000);
      expect(sockets).toHaveLength(entry.retryable ? 2 : 1);
      if (entry.retryable) {
        expect(failed).not.toHaveBeenCalled();
        latest().emit('open');
        receive(deviceConfirmation());
        expect(client.connectionStatus).toBe('connected');
      } else {
        expect(failed).toHaveBeenCalledWith(code);
        expect(client.connectionStatus).toBe('disconnected');
      }
    },
  );

  it('backs off rejections, preserves connectionId, and resets after successful auth', async () => {
    create();
    const retry = vi.fn();
    client.on('reconnecting', retry);
    await client.connect();
    const id = new URL(latest().url).searchParams.get('connectionId');
    expect(id).toBeTruthy();
    for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
      latest().emit('open');
      receive({ type: 'auth_failed', code: 'DEVICE_EXECUTOR_UNAVAILABLE' });
      expect(retry).toHaveBeenLastCalledWith(delay);
      const count = sockets.length;
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(sockets).toHaveLength(count);
      await vi.advanceTimersByTimeAsync(1);
      expect(sockets).toHaveLength(count + 1);
      expect(new URL(latest().url).searchParams.get('connectionId')).toBe(id);
    }
    latest().emit('open');
    receive(deviceConfirmation());
    latest().emit('close', 1006, Buffer.from(''));
    expect(retry).toHaveBeenLastCalledWith(1000);
    await client.reconnect();
    expect(new URL(latest().url).searchParams.get('connectionId')).toBe(id);
  });

  it.each([false, true])(
    'respects autoReconnect=%s and explicit disconnect',
    async (autoReconnect) => {
      create(autoReconnect);
      await client.connect();
      latest().emit('open');
      receive({ type: 'auth_failed', code: 'GATEWAY_AUTHORITY_UNAVAILABLE' });
      if (autoReconnect) await client.disconnect();
      await vi.advanceTimersByTimeAsync(5000);
      expect(sockets).toHaveLength(1);
    },
  );

  it('does not retry an unknown code based on a reason string', async () => {
    create();
    const failed = vi.fn();
    client.on('auth_failed', failed);
    await client.connect();
    receive({ type: 'auth_failed', code: 'UNKNOWN', reason: 'TENANT_NOT_READY' });
    await vi.advanceTimersByTimeAsync(5000);
    expect(sockets).toHaveLength(1);
    expect(failed).toHaveBeenCalledWith('UNKNOWN');
  });
});

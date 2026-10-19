import type { EventEmitter } from 'node:events';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import protocol from '../../../contracts/gateway-tenancy/v1/protocol.json';
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
  sockets.length = 0;
});
afterEach(async () => {
  await client?.disconnect();
  vi.useRealTimers();
});

describe('device gateway rejection recovery', () => {
  it.each(Object.entries(protocol.errors))(
    '%s follows the frozen retry policy',
    async (code, entry) => {
      create();
      const failed = vi.fn();
      client.on('auth_failed', failed);
      await client.connect();
      latest().emit('open');
      receive({ type: entry.wsEvent, code, reason: 'human-readable detail' });
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

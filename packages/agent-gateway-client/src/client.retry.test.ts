import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import protocol from '../../../contracts/gateway-tenancy/v1/protocol.json';
import { testConfirmation, testTicket } from './__tests__/fixtures';
import { createClient, getLatestWs, mockWsInstances } from './__tests__/setup';
import type { AgentStreamClient } from './client';
import { gatewayIdentityHint } from './tenancy';

let client: AgentStreamClient;
beforeEach(() => vi.spyOn(Math, 'random').mockReturnValue(1));
afterEach(() => {
  client?.disconnect();
  vi.restoreAllMocks();
});

describe('agent gateway rejection recovery', () => {
  it('honors disconnect from a reconnecting listener', async () => {
    client = createClient();
    client.on('reconnecting', () => client.disconnect());
    client.connect();
    await vi.advanceTimersByTimeAsync(1);
    getLatestWs().simulateClose();
    await vi.advanceTimersByTimeAsync(5000);
    expect(mockWsInstances).toHaveLength(1);
    expect(client.connectionStatus).toBe('disconnected');
  });

  it('jitters reconnects within half of the capped exponential budget', async () => {
    vi.mocked(Math.random).mockReturnValue(0.25);
    client = createClient();
    const retry = vi.fn();
    client.on('reconnecting', retry);
    client.connect();
    await vi.advanceTimersByTimeAsync(1);
    for (const budget of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
      getLatestWs().simulateClose();
      const delay = retry.mock.calls.at(-1)![0];
      expect(delay).toBe(budget * 0.625);
      await vi.advanceTimersByTimeAsync(delay + 1);
    }
  });

  it('re-mints an expiry-rejected ticket with the same connectionId', async () => {
    const identity = gatewayIdentityHint(testTicket(), 'urn:lobehub:gateway:agent', 'op-123');
    const provider = vi
      .fn()
      .mockResolvedValueOnce(identity)
      .mockResolvedValue({ ...identity, gatewayTicket: 'fresh-ticket' });
    client = createClient({ identityProvider: provider });
    client.connect();
    await vi.advanceTimersByTimeAsync(1);
    const id = new URL(getLatestWs().url).searchParams.get('connectionId');
    getLatestWs().simulateMessage({ type: 'auth_expired' });
    await vi.advanceTimersByTimeAsync(1001);
    expect(provider).toHaveBeenCalledTimes(2);
    expect(provider.mock.calls[1][0]).toMatchObject({
      connectionId: id,
      renewAuthorizationId: identity.authorizationId,
    });
    expect(JSON.parse(getLatestWs().sent[0])).toMatchObject({ token: 'fresh-ticket' });
  });

  it('surfaces a policy close without a frame and stops retrying', async () => {
    client = createClient();
    const failed = vi.fn();
    client.on('auth_failed', failed);
    client.connect();
    await vi.advanceTimersByTimeAsync(1);
    getLatestWs().onclose?.({ code: 1008, reason: 'TENANT_FROZEN' });
    await vi.advanceTimersByTimeAsync(5000);
    expect(mockWsInstances).toHaveLength(1);
    expect(failed).toHaveBeenCalledWith('TENANT_FROZEN');
  });

  it('re-mints after local expiry and aborts a stalled renewal', async () => {
    const identity = gatewayIdentityHint(testTicket(), 'urn:lobehub:gateway:agent', 'op-123');
    const first = { ...identity, ticketExpiresAt: Date.now() + 2000 };
    const provider = vi
      .fn()
      .mockResolvedValueOnce(first)
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValue(identity);
    client = createClient({ identityProvider: provider });
    client.connect();
    await vi.advanceTimersByTimeAsync(1);
    getLatestWs().simulateMessage({
      ...testConfirmation(),
      ticketExpiresAt: first.ticketExpiresAt,
    });
    await vi.advanceTimersByTimeAsync(3000);
    expect(provider).toHaveBeenCalledTimes(3);
    expect(provider.mock.calls[1][0].signal.aborted).toBe(true);
    expect(mockWsInstances).toHaveLength(2);
    expect(provider.mock.calls[2][0].connectionId).toBe(provider.mock.calls[0][0].connectionId);
  });

  it.each(Object.entries(protocol.errors))(
    '%s follows the frozen retry policy',
    async (code, entry) => {
      client = createClient();
      const failed = vi.fn();
      client.on('auth_failed', failed);
      client.connect();
      await vi.advanceTimersByTimeAsync(1);
      const socket = getLatestWs();
      socket.simulateMessage({
        type: entry.wsEvent,
        code,
        retryable: entry.retryable,
        reason: 'human-readable detail',
      });
      await vi.advanceTimersByTimeAsync(1001);
      expect(mockWsInstances).toHaveLength(entry.retryable ? 2 : 1);
      if (entry.retryable) {
        expect(failed).not.toHaveBeenCalled();
        getLatestWs().simulateMessage(testConfirmation());
        expect(client.connectionStatus).toBe('connected');
      } else {
        expect(failed).toHaveBeenCalledWith(code);
        expect(client.connectionStatus).toBe('disconnected');
      }
    },
  );

  it('backs off repeated rejections and resets only after authenticated recovery', async () => {
    client = createClient();
    const retry = vi.fn();
    client.on('reconnecting', retry);
    client.connect();
    await vi.advanceTimersByTimeAsync(1);
    for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
      getLatestWs().simulateMessage({ type: 'auth_failed', code: 'DEVICE_EXECUTOR_UNAVAILABLE' });
      expect(retry).toHaveBeenLastCalledWith(delay);
      const count = mockWsInstances.length;
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(mockWsInstances).toHaveLength(count);
      await vi.advanceTimersByTimeAsync(2);
      expect(mockWsInstances).toHaveLength(count + 1);
    }
    getLatestWs().simulateMessage(testConfirmation());
    getLatestWs().simulateClose();
    expect(retry).toHaveBeenLastCalledWith(1000);
  });

  it('keeps a distinct connectionId per client across automatic and explicit reconnects', async () => {
    client = createClient();
    client.connect();
    await vi.advanceTimersByTimeAsync(1);
    const id = new URL(getLatestWs().url).searchParams.get('connectionId');
    expect(id).toMatch(/^[\da-f-]{36}$/i);
    getLatestWs().simulateClose();
    await vi.advanceTimersByTimeAsync(1001);
    expect(new URL(getLatestWs().url).searchParams.get('connectionId')).toBe(id);
    await client.reconnect();
    expect(new URL(getLatestWs().url).searchParams.get('connectionId')).toBe(id);
    const other = createClient();
    other.connect();
    expect(new URL(getLatestWs().url).searchParams.get('connectionId')).not.toBe(id);
    other.disconnect();
  });

  it('preserves a caller-provided connectionId as a URL hint', async () => {
    client = createClient({ connectionId: 'socket/with spaces' });
    client.connect();
    await vi.advanceTimersByTimeAsync(1);
    expect(new URL(getLatestWs().url).searchParams.get('connectionId')).toBe('socket/with spaces');
    await client.reconnect();
    expect(new URL(getLatestWs().url).searchParams.get('connectionId')).toBe('socket/with spaces');
  });

  it.each([false, true])(
    'respects autoReconnect=%s and explicit disconnect',
    async (autoReconnect) => {
      client = createClient({ autoReconnect });
      client.connect();
      await vi.advanceTimersByTimeAsync(1);
      getLatestWs().simulateMessage({ type: 'auth_failed', code: 'GATEWAY_AUTHORITY_UNAVAILABLE' });
      if (autoReconnect) client.disconnect();
      await vi.advanceTimersByTimeAsync(5000);
      expect(mockWsInstances).toHaveLength(1);
    },
  );

  it('treats unknown codes as terminal even when reason contains a retryable code', async () => {
    client = createClient();
    const failed = vi.fn();
    client.on('auth_failed', failed);
    client.connect();
    await vi.advanceTimersByTimeAsync(1);
    getLatestWs().simulateMessage({
      type: 'auth_failed',
      code: 'UNKNOWN',
      reason: 'TENANT_NOT_READY',
    });
    await vi.advanceTimersByTimeAsync(5000);
    expect(mockWsInstances).toHaveLength(1);
    expect(failed).toHaveBeenCalledWith('UNKNOWN');
  });
});

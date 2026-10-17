import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { testConfirmation, testTicket } from './__tests__/fixtures';
import { AgentStreamClient } from './client';
import { gatewayIdentityHint } from './tenancy';

class Socket {
  static OPEN = 1;
  static CONNECTING = 0;
  static instances: Socket[] = [];
  readyState = 1;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  send = vi.fn();
  close = vi.fn();
  constructor() {
    Socket.instances.push(this);
  }
  receive(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}
const clients: AgentStreamClient[] = [];
const create = (provider: any) => {
  const client = new AgentStreamClient({
    gatewayUrl: 'https://gw.invalid',
    operationId: 'op-123',
    token: 'TEST-ONLY',
    identityProvider: provider,
  });
  clients.push(client);
  return client;
};
beforeEach(() => {
  vi.useFakeTimers();
  Socket.instances = [];
  vi.stubGlobal('WebSocket', Socket);
});
afterEach(() => {
  clients.splice(0).forEach((client) => client.disconnect());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe('owning agent provider lifecycle', () => {
  it('terminates an unverifiable provider without retry', async () => {
    const provider = vi.fn().mockRejectedValue(new Error('SOURCE_UNVERIFIABLE'));
    const client = create(provider);
    const failed = vi.fn();
    client.on('auth_failed', failed);
    client.connect();
    await vi.advanceTimersByTimeAsync(5000);
    expect(failed).toHaveBeenCalledWith('SOURCE_UNVERIFIABLE');
    expect(provider).toHaveBeenCalledOnce();
  });
  it('keeps temporary network failures retryable', async () => {
    const provider = vi.fn().mockRejectedValue(new Error('Failed to fetch'));
    const client = create(provider);
    const failed = vi.fn();
    client.on('auth_failed', failed);
    client.connect();
    await vi.advanceTimersByTimeAsync(1000);
    expect(provider).toHaveBeenCalledTimes(2);
    expect(failed).not.toHaveBeenCalled();
  });
  it('does not emit a late rejected provider result after disconnect', async () => {
    let reject!: (reason: Error) => void;
    const client = create(
      () =>
        new Promise((_yes, no) => {
          reject = no;
        }),
    );
    const failed = vi.fn();
    client.on('auth_failed', failed);
    client.connect();
    client.disconnect();
    reject(new Error('SOURCE_UNVERIFIABLE'));
    await vi.advanceTimersByTimeAsync(5000);
    expect(failed).not.toHaveBeenCalled();
    expect(Socket.instances).toHaveLength(0);
  });
  it('renews on the same socket without another connected or resume event', async () => {
    const now = Date.now();
    const first = {
      ...gatewayIdentityHint(testTicket(), 'urn:lobehub:gateway:agent', 'op-123'),
      ticketExpiresAt: now + 10000,
      authRecordExpiresAt: now + 10000,
    };
    const next = {
      ...first,
      gatewayTicket: 'TEST-ONLY-NEW',
      ticketExpiresAt: now + 20000,
      authRecordExpiresAt: now + 20000,
    };
    const provider = vi.fn().mockResolvedValueOnce(first).mockResolvedValue(next);
    const client = create(provider);
    const connected = vi.fn();
    client.on('connected', connected);
    client.connect();
    await vi.advanceTimersByTimeAsync(0);
    const socket = Socket.instances[0];
    socket.onopen?.();
    socket.receive({
      ...testConfirmation(),
      ticketExpiresAt: first.ticketExpiresAt,
      authRecordExpiresAt: first.authRecordExpiresAt,
    });
    await vi.advanceTimersByTimeAsync(5000);
    expect(Socket.instances).toHaveLength(1);
    expect(JSON.parse(socket.send.mock.calls.at(-1)![0])).toMatchObject({
      type: 'auth',
      token: next.gatewayTicket,
    });
    socket.receive({
      ...testConfirmation(),
      connectionGeneration: 2,
      ticketExpiresAt: next.ticketExpiresAt,
      authRecordExpiresAt: next.authRecordExpiresAt,
    });
    expect(connected).toHaveBeenCalledOnce();
    expect(client.connectionStatus).toBe('connected');
  });
});

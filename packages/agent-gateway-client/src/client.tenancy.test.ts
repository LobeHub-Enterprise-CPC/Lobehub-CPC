import { existsSync, readFileSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentStreamClient } from './client';

const fixtures = JSON.parse(
  readFileSync(
    existsSync('contracts/gateway-tenancy/v1/fixtures/ws-auth.json')
      ? 'contracts/gateway-tenancy/v1/fixtures/ws-auth.json'
      : '../../contracts/gateway-tenancy/v1/fixtures/ws-auth.json',
    'utf8',
  ),
);
const confirmation = fixtures.cases.find(
  (c: { id: string }) => c.id === 'auth-success-valid',
).input;
const claims = {
  iss: 'urn:lobehub:gateway-session',
  aud: 'urn:lobehub:gateway:agent',
  purpose: 'gateway-connect',
  tid: 'tenant-A',
  sub: 'user-shared',
  principal: confirmation.principal,
  capabilities: confirmation.roles,
  operation_id: 'op',
  accepted_version: 7,
  authorization_id: 'auth-A',
  exp: 1900000300,
};
const token = `TEST.${btoa(JSON.stringify(claims))}.TEST`;
class Socket {
  static OPEN = 1;
  static CONNECTING = 0;
  static instances: Socket[] = [];
  readyState = 1;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  sent: string[] = [];
  constructor(public url: string) {
    Socket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
  }
  receive(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
}
const clients: AgentStreamClient[] = [];
const connect = () => {
  const client = new AgentStreamClient({
    gatewayUrl: 'https://gw.invalid/tenant/v1/',
    operationId: 'op',
    token,
    autoReconnect: false,
  });
  clients.push(client);
  client.connect();
  const socket = Socket.instances.at(-1)!;
  socket.onopen?.();
  return { client, socket };
};
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1900000000000);
  vi.stubGlobal('WebSocket', Socket);
  Socket.instances = [];
});
afterEach(() => {
  clients.forEach((c) => c.disconnect());
  clients.length = 0;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe('strict actual agent socket authority', () => {
  it('uses the strict prefix once and includes the tenancy handshake', () => {
    const { socket } = connect();
    expect(socket.url).toBe('wss://gw.invalid/tenant/v1/ws?operationId=op');
    expect(JSON.parse(socket.sent[0])).toMatchObject({ tenancyProtocol: 1, tokenType: 'jwt' });
  });
  it.each([
    'auth-success-missing-audience',
    'auth-success-missing-tenantId',
    'auth-success-missing-leaseExpiresAt',
    'auth-success-missing-tenancyProtocol',
    'auth-success-wrong-principal',
    'auth-success-wrong-acceptedVersion',
    'auth-success-wrong-audience',
    'auth-success-wrong-tenantId',
  ])('refuses %s before visible connection', (id) => {
    const entry = fixtures.cases.find((c: { id: string }) => c.id === id);
    const { client, socket } = connect();
    const denied = vi.fn();
    client.on('auth_failed', denied);
    socket.receive(entry?.input ?? { ...confirmation, tenantId: 'tenant-B' });
    expect(client.connectionStatus).not.toBe('connected');
    expect(denied).toHaveBeenCalledWith(entry.expected.code);
  });
  it.each(['llm_execute', 'llm_cancel'])(
    'rejects %s before the retained browser executor receives it',
    (type) => {
      const { client, socket } = connect();
      const execute = vi.fn();
      client.on('agent_event', execute);
      socket.receive(confirmation);
      socket.receive({
        type: 'agent_event',
        event: { type, operationId: 'op', data: { callId: 'call' } },
      });
      expect(execute).not.toHaveBeenCalled();
    },
  );
  it('drops events before confirmation and from a superseded actual socket', async () => {
    const { client, socket } = connect();
    const seen = vi.fn();
    client.on('agent_event', seen);
    const staleListener = socket.onmessage!;
    socket.receive({ type: 'agent_event', event: { type: 'text', operationId: 'op' } });
    expect(seen).not.toHaveBeenCalled();
    socket.receive(confirmation);
    await client.reconnect();
    staleListener({
      data: JSON.stringify({ type: 'agent_event', event: { type: 'text', operationId: 'op' } }),
    });
    expect(seen).not.toHaveBeenCalled();
  });
  it('does not extend an absolute lease at reception or after a backwards wall clock', () => {
    const { client, socket } = connect();
    socket.receive({ ...confirmation, leaseExpiresAt: Date.now() + 1000 });
    vi.setSystemTime(1900000002000);
    expect(client.sendToolResult({ toolCallId: 'tool', content: '', success: true })).toBe(false);
    vi.setSystemTime(1899999990000);
    expect(client.sendToolResult({ toolCallId: 'tool', content: '', success: true })).toBe(false);
  });
});

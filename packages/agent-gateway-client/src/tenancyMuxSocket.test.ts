import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import muxFixtures from '../../../contracts/gateway-tenancy/v2/fixtures/mux.json';
import authFixtures from '../../../contracts/gateway-tenancy/v2/fixtures/ws-auth.json';
import { GatewayMuxClient } from './mux/GatewayMuxClient';
import { createTenancyMuxTransport } from './tenancyMuxSocket';

const fixture = authFixtures.cases.find((entry) => entry.id === 'mux-user-handshake')!;
const claims = fixture.context!.ticketClaims!;
const NOW = 1900000000000;
const ticket = (extra = {}) => `header.${btoa(JSON.stringify({ ...claims, ...extra }))}.signature`;
const auth = (extra = {}) => ({
  ...fixture.context!.expectedFrames![0],
  roles: claims.capabilities,
  ...extra,
});
const stamp = { tenancyProtocol: 1, tenantId: 'tenant-A', connectionGeneration: 3 };
const ready = { ...fixture.context!.expectedFrames![1] };

class Socket {
  static OPEN = 1;
  static CLOSED = 3;
  static CONNECTING = 0;
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  sent: Record<string, unknown>[] = [];
  close = vi.fn(() => {
    this.readyState = 3;
  });
  constructor(readonly url: string) {}
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  open() {
    this.readyState = 1;
    this.onopen?.(new Event('open'));
  }
  receive(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent);
  }
}
const muxes: GatewayMuxClient[] = [];
const setup = (overrides = {}) => {
  const physical: Socket[] = [];
  const issueToken = vi.fn(async () => ({ token: ticket() }));
  const transport = createTenancyMuxTransport({
    clientId: 'tab-1',
    gatewayUrl: 'https://gw/agent-gateway/tenant/v1',
    issueToken,
    createWebSocket: (url) => {
      const socket = new Socket(url);
      physical.push(socket);
      return socket as unknown as WebSocket;
    },
    ...overrides,
  });
  const socket = transport.createWebSocket(`wss://gw/v2/ws?clientId=tab-1&token=${ticket()}`);
  const messages = vi.fn();
  const closed = vi.fn();
  socket.onmessage = messages;
  socket.onclose = closed;
  physical[0].open();
  return { transport, socket, raw: physical[0], physical, issueToken, messages, closed };
};
const connect = (value: ReturnType<typeof setup>) => {
  value.raw.receive(auth());
  value.raw.receive(ready);
};
const command = (extra = {}) => ({
  ...stamp,
  type: 'tool_execute',
  sourceAcceptedVersion: 7,
  operationId: 'op',
  toolCallId: 'tool',
  attemptId: 'attempt',
  data: { identifier: 'test', apiName: 'run', arguments: '{}', executionTimeoutMs: 1000 },
  ...extra,
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubGlobal('WebSocket', Socket);
});
afterEach(() => {
  for (const mux of muxes.splice(0)) mux.disconnect();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('tenancy mux socket', () => {
  it.each([
    'ready-valid',
    'subscribe-failed-valid',
    'outage-error-valid',
    'resume-valid',
    'message-patch-mux',
  ])('passes the frozen %s frame unchanged', (id) => {
    const value = setup();
    connect(value);
    value.messages.mockClear();
    const frame = muxFixtures.cases.find((entry) => entry.id === id)!.input;
    value.raw.receive(frame);
    expect(JSON.parse(value.messages.mock.calls[0][0].data)).toEqual(frame);
    value.socket.close();
  });

  it('refreshes a retryable failure on the real mux and resumes its operation', async () => {
    const value = setup();
    value.socket.close();
    const mux = new GatewayMuxClient({
      ...value.transport,
      clientId: 'tab-1',
      gatewayUrl: 'https://gw',
      keepAlive: true,
    });
    muxes.push(mux);
    value.transport.bindMux(mux);
    const events = vi.fn();
    const unavailable = vi.fn();
    mux.on('unavailable', unavailable);
    mux.subscribe('op', { executor: true }).on('agent_event', events);
    await vi.advanceTimersByTimeAsync(0);
    value.physical[1].open();
    value.physical[1].receive(auth());
    value.physical[1].receive(ready);
    value.physical[1].receive({ type: 'tenant_unavailable', code: 'TENANT_NOT_READY' });
    await vi.advanceTimersByTimeAsync(0);
    expect(value.issueToken).toHaveBeenCalledTimes(2);
    value.physical[2].open();
    value.physical[2].receive(auth());
    value.physical[2].receive(ready);
    value.physical[2].receive(command());
    expect(events).toHaveBeenCalledOnce();
    expect(events.mock.calls[0][0].data.isExecutionCurrent()).toBe(true);
    expect(unavailable).not.toHaveBeenCalled();
  });

  it('uses the strict URL and first-frame auth, dropping pre-auth ready', () => {
    const value = setup();
    expect(value.raw.url).toBe('wss://gw/agent-gateway/tenant/v1/v2/ws?clientId=tab-1');
    expect(value.raw.sent).toEqual([
      { type: 'auth', tenancyProtocol: 1, tokenType: 'jwt', token: ticket() },
    ]);
    value.raw.receive(ready);
    expect(value.messages).not.toHaveBeenCalled();
    connect(value);
    expect(value.messages).toHaveBeenCalledOnce();
    expect(JSON.parse(value.messages.mock.calls[0][0].data)).toEqual(ready);
    value.socket.close();
  });

  it.each([
    { tenantId: 'foreign' },
    { audience: 'urn:lobehub:gateway:device' },
    { principal: { kind: 'user', id: 'foreign' } },
    { acceptedVersion: 8 },
    { connectionGeneration: 0 },
    { leaseExpiresAt: NOW - 1 },
  ])('rejects invalid confirmation %j', (extra) => {
    const value = setup();
    value.raw.receive(auth(extra));
    expect(value.closed).toHaveBeenCalledWith(expect.objectContaining({ code: 4401 }));
    expect(value.messages).not.toHaveBeenCalled();
  });

  it('caps an overlong lease at 30s and expires without server renewal', async () => {
    const value = setup();
    value.raw.receive(auth({ leaseExpiresAt: NOW + 60000 }));
    await vi.advanceTimersByTimeAsync(30000);
    expect(value.raw.close).toHaveBeenCalled();
    expect(value.messages).not.toHaveBeenCalled();
  });

  it('consumes lease updates and extends the live lease at the same generation', async () => {
    const value = setup();
    value.raw.receive(auth({ leaseExpiresAt: NOW + 1000 }));
    await vi.advanceTimersByTimeAsync(500);
    value.raw.receive(auth({ type: 'lease_update', leaseExpiresAt: NOW + 20000 }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(value.closed).not.toHaveBeenCalled();
    expect(value.messages).not.toHaveBeenCalled();
    value.socket.close();
  });

  it('renews in socket under the original authorization and requires generation + 1', async () => {
    const value = setup({
      issueToken: vi.fn(async () => ({ token: ticket({ exp: 1900000600 }) })),
    });
    value.raw.receive(auth({ ticketExpiresAt: NOW + 10000, authRecordExpiresAt: NOW + 10000 }));
    await vi.advanceTimersByTimeAsync(5000);
    expect(value.raw.sent.at(-1)).toMatchObject({
      type: 'auth',
      token: ticket({ exp: 1900000600 }),
    });
    value.raw.receive(auth({ connectionGeneration: 4 }));
    value.raw.receive({ ...ready, connectionGeneration: 4 });
    expect(value.closed).not.toHaveBeenCalled();
    expect(value.messages).toHaveBeenCalledOnce();
    value.socket.close();
  });

  it.each([3, 5])('refuses renewal generation %s', async (generation) => {
    const value = setup();
    value.raw.receive(auth({ ticketExpiresAt: NOW + 10000, authRecordExpiresAt: NOW + 10000 }));
    await vi.advanceTimersByTimeAsync(5000);
    expect(value.issueToken).toHaveBeenCalledWith({
      clientId: 'tab-1',
      authorizationId: 'auth-agent-A',
    });
    value.raw.receive(auth({ connectionGeneration: generation }));
    expect(value.closed).toHaveBeenCalledOnce();
  });

  it.each(['TENANT_NOT_READY', 'GATEWAY_AUTHORITY_UNAVAILABLE'])(
    'maps retryable %s to refresh',
    async (code) => {
      const value = setup();
      value.raw.receive({ type: 'auth_failed', code });
      expect(value.closed).toHaveBeenCalledWith(expect.objectContaining({ code: 4401 }));
      await expect(value.transport.getToken()).resolves.toBe(ticket());
    },
  );

  it.each(['UNAUTHORIZED', 'MUX_UNSUPPORTED', 'TENANT_FROZEN'])(
    'makes terminal %s fail subsequent local dials',
    async (code) => {
      const value = setup();
      value.raw.receive({ type: 'capability_failed', code });
      await expect(value.transport.getToken()).rejects.toThrow(code);
      expect(value.issueToken).not.toHaveBeenCalled();
    },
  );

  it.each([{ tenantId: 'foreign' }, { connectionGeneration: 2 }, { sourceAcceptedVersion: 8 }])(
    'closes on a bad stamp %j',
    (extra) => {
      const value = setup();
      connect(value);
      value.messages.mockClear();
      value.raw.receive({ ...stamp, type: 'heartbeat_ack', ...extra });
      expect(value.closed).toHaveBeenCalledOnce();
      expect(value.messages).not.toHaveBeenCalled();
    },
  );

  it.each(['resume_complete', 'subscribe_failed', 'op_lifecycle', 'error', 'agent_event'])(
    'passes %s unchanged',
    (type) => {
      const value = setup();
      connect(value);
      value.messages.mockClear();
      const frame = {
        ...stamp,
        type,
        operationId: 'op',
        sourceAcceptedVersion: 7,
        event: { type: 'message_patch', data: {} },
      };
      value.raw.receive(frame);
      expect(JSON.parse(value.messages.mock.calls[0][0].data)).toEqual(frame);
      value.socket.close();
    },
  );

  it('passes subscribe/unsubscribe through and binds tool/confirmation/input responses', () => {
    const value = setup();
    connect(value);
    const subscribe = { type: 'subscribe', operationId: 'op', executor: true };
    value.socket.send(JSON.stringify(subscribe));
    expect(value.raw.sent.at(-1)).toEqual(subscribe);
    for (const [type, response, id] of [
      ['tool_execute', 'tool_result', 'toolCallId'],
      ['tool_confirmation_request', 'tool_confirmation', 'toolCallId'],
      ['input_request', 'user_input', 'requestId'],
    ]) {
      value.raw.receive(command({ type, toolCallId: undefined, [id]: type }));
      value.socket.send(
        JSON.stringify({ type: response, operationId: 'op', [id]: type, attemptId: 'attempt' }),
      );
      expect(value.raw.sent.at(-1)).toMatchObject({
        ...stamp,
        type: response,
        sourceAcceptedVersion: 7,
        operationId: 'op',
        [id]: type,
        attemptId: 'attempt',
      });
    }
    const unsubscribe = { type: 'unsubscribe', operationId: 'op' };
    value.socket.send(JSON.stringify(unsubscribe));
    expect(value.raw.sent.at(-1)).toEqual(unsubscribe);
    value.socket.close();
  });

  it.each([
    { tenantId: 'foreign' },
    { sourceAcceptedVersion: 8 },
    { connectionGeneration: 2 },
    { toolCallId: undefined },
  ])('refuses a command with invalid binding %j', (extra) => {
    const value = setup();
    connect(value);
    value.messages.mockClear();
    value.socket.send(JSON.stringify({ type: 'subscribe', operationId: 'op', executor: true }));
    value.raw.receive(command(extra));
    expect(value.messages).not.toHaveBeenCalled();
    expect(value.closed).toHaveBeenCalledOnce();
  });

  it('refuses a lease update that changes generation', () => {
    const value = setup();
    connect(value);
    value.raw.receive(auth({ type: 'lease_update', connectionGeneration: 4 }));
    expect(value.closed).toHaveBeenCalledOnce();
  });

  it('never rebinds a delayed confirmation to a newer attempt using the same request ID', () => {
    const value = setup();
    connect(value);
    value.socket.send(JSON.stringify({ type: 'subscribe', operationId: 'op', executor: true }));
    value.raw.receive(command({ type: 'tool_confirmation_request' }));
    value.socket.send(
      JSON.stringify({
        type: 'tool_confirmation',
        operationId: 'op',
        toolCallId: 'tool',
        approved: true,
      }),
    );
    expect(value.raw.sent.at(-1)).toMatchObject({
      type: 'tool_confirmation',
      attemptId: 'attempt',
    });
    value.raw.receive(command({ type: 'tool_confirmation_request', attemptId: 'new-attempt' }));
    expect(value.closed).toHaveBeenCalledOnce();
    const sent = value.raw.sent.length;
    value.socket.send(
      JSON.stringify({
        type: 'tool_confirmation',
        operationId: 'op',
        toolCallId: 'tool',
        approved: true,
      }),
    );
    expect(value.raw.sent).toHaveLength(sent);
  });

  it('refuses duplicate execution attempts and mismatched outgoing attempts', () => {
    const value = setup();
    connect(value);
    value.socket.send(JSON.stringify({ type: 'subscribe', operationId: 'op', executor: true }));
    value.raw.receive(command());
    const before = value.raw.sent.length;
    value.socket.send(
      JSON.stringify({
        type: 'tool_result',
        operationId: 'op',
        toolCallId: 'tool',
        attemptId: 'foreign',
      }),
    );
    expect(value.raw.sent).toHaveLength(before);
    value.raw.receive(command());
    expect(value.closed).toHaveBeenCalledOnce();
  });

  it.each(['llm_execute', 'llm_cancel'])('refuses %s', (type) => {
    const value = setup();
    connect(value);
    value.raw.receive({ ...stamp, type });
    expect(value.closed).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'LLM_RELAY_UNSUPPORTED' }),
    );
  });

  it('routes flat tools through the unmodified mux with local execution guards', async () => {
    const value = setup();
    value.socket.close();
    const mux = new GatewayMuxClient({
      ...value.transport,
      clientId: 'tab-1',
      gatewayUrl: 'https://gw',
      keepAlive: true,
    });
    value.transport.bindMux(mux);
    muxes.push(mux);
    const subscription = mux.subscribe('op', { executor: true });
    const received = vi.fn();
    subscription.on('agent_event', received);
    await vi.advanceTimersByTimeAsync(0);
    const raw = value.physical[1];
    raw.open();
    raw.receive(auth({ ticketExpiresAt: NOW + 10000 }));
    raw.receive(ready);
    raw.receive(command());
    const event = received.mock.calls[0][0];
    expect(event.data.attemptId).toBe('attempt');
    expect(event.data.executionSignal).toBeInstanceOf(AbortSignal);
    expect(event.data.isExecutionCurrent()).toBe(true);
    subscription.sendToolResult({
      toolCallId: 'tool',
      content: 'ok',
      success: true,
      attemptId: 'attempt',
    });
    expect(raw.sent.at(-1)).toMatchObject({
      ...stamp,
      operationId: 'op',
      toolCallId: 'tool',
      attemptId: 'attempt',
    });
    await vi.advanceTimersByTimeAsync(5000);
    raw.receive(auth({ connectionGeneration: 4 }));
    expect(event.data.executionSignal.aborted).toBe(true);
    expect(event.data.isExecutionCurrent()).toBe(false);
    mux.disconnect();
  });

  it('maps opaque browser upgrade failures to unavailable after the unchanged dial budget', async () => {
    const value = setup();
    value.socket.close();
    const mux = new GatewayMuxClient({
      ...value.transport,
      clientId: 'tab-1',
      gatewayUrl: 'https://gw',
      keepAlive: true,
    });
    muxes.push(mux);
    const unavailable = vi.fn();
    mux.on('unavailable', unavailable);
    const connected = mux.connect().catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    for (let index = 1; index <= 3; index++) {
      const raw = value.physical[index];
      raw.onerror?.(new Event('error'));
      raw.onclose?.({ code: 1006, reason: '' } as CloseEvent);
      await vi.advanceTimersByTimeAsync(10000);
    }
    await connected;
    expect(unavailable).toHaveBeenCalledOnce();
    expect(value.physical).toHaveLength(4);
  });

  it.each([404, 426, 501])(
    'maps an observable HTTP %s upgrade refusal to terminal',
    async (status) => {
      const value = setup();
      value.raw.onerror?.({ status } as unknown as Event);
      await expect(value.transport.getToken()).rejects.toThrow('GATEWAY_TENANCY_UNSUPPORTED');
    },
  );

  it.each(['MUX_UNSUPPORTED', 'UNAUTHORIZED', 'GATEWAY_TENANCY_UNSUPPORTED'])(
    'reaches real mux unavailable after terminal %s without another physical dial',
    async (code) => {
      const value = setup();
      value.socket.close();
      const mux = new GatewayMuxClient({
        ...value.transport,
        clientId: 'tab-1',
        gatewayUrl: 'https://gw',
        keepAlive: true,
        maxDialFailures: 1,
      });
      muxes.push(mux);
      const unavailable = vi.fn();
      mux.on('unavailable', unavailable);
      const connected = mux.connect().catch(() => {});
      await vi.advanceTimersByTimeAsync(0);
      const raw = value.physical[1];
      raw.open();
      raw.receive({ type: 'capability_failed', code });
      await vi.advanceTimersByTimeAsync(0);
      await connected;
      expect(unavailable).toHaveBeenCalledOnce();
      expect(value.physical).toHaveLength(2);
    },
  );
});

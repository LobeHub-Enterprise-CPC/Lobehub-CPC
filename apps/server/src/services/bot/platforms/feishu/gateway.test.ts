import { EventEmitter } from 'node:events';

import { runWithTenantScope } from '@lobechat/database/tenant';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FeishuWSConnection } from './gateway';

// ---- Mock @larksuiteoapi/node-sdk ----

const mockStart = vi.fn().mockResolvedValue(undefined);
const mockClose = vi.fn();
const mockConfig = vi.fn().mockResolvedValue({ ok: true });
const mockConnect = vi.fn().mockResolvedValue(false);
const mockReconnect = vi.fn().mockResolvedValue(undefined);
let lastClient: any;
let socket: (EventEmitter & { readyState: number }) | null = null;
let capturedEventHandlers: Record<string, (...args: any[]) => any> = {};

vi.mock('@larksuiteoapi/node-sdk', () => {
  class MockEventDispatcher {
    register(handles: Record<string, (...args: any[]) => any>) {
      capturedEventHandlers = { ...capturedEventHandlers, ...handles };
      return this;
    }
  }

  class MockWSClient {
    closed = false;
    connect = mockConnect;
    pullConnectConfig = mockConfig;
    close(params: unknown) {
      this.closed = true;
      mockClose(params);
      if (socket) this.detachSocket(socket);
    }
    detachSocket(target: EventEmitter) {
      target.removeAllListeners();
    }
    reConnect = mockReconnect;
    wsConfig = { getWSInstance: () => socket };
    start = mockStart;
    constructor() {
      // Expose the SDK instance so the test can trigger its background reconnect.
      // eslint-disable-next-line @typescript-eslint/no-this-alias
      lastClient = this;
    }
  }

  return {
    Domain: { Feishu: 0, Lark: 1 },
    EventDispatcher: MockEventDispatcher,
    LoggerLevel: { info: 3 },
    WSClient: MockWSClient,
  };
});

// ---- Tests ----

describe('FeishuWSConnection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    socket = null;
    mockReconnect.mockReset().mockResolvedValue(undefined);
    capturedEventHandlers = {};
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('ok', { status: 200 })));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function createConnection() {
    return new FeishuWSConnection({
      appId: 'cli_test',
      appSecret: 'test_secret',
      domain: 'feishu',
      webhookUrl: 'http://localhost:3000/api/agent/webhooks/feishu/test_app',
    });
  }

  describe('start', () => {
    it('should call WSClient.start with EventDispatcher', async () => {
      const conn = createConnection();
      await conn.start();

      expect(mockStart).toHaveBeenCalledWith(
        expect.objectContaining({ eventDispatcher: expect.any(Object) }),
      );
    });

    it('should register im.message.receive_v1 handler', async () => {
      const conn = createConnection();
      await conn.start();

      expect(capturedEventHandlers['im.message.receive_v1']).toBeTypeOf('function');
    });
  });

  describe('event forwarding', () => {
    it('should forward im.message.receive_v1 events to webhook URL', async () => {
      const conn = createConnection();
      await conn.start();

      const eventData = {
        message: {
          chat_id: 'oc_test',
          content: '{"text":"hello"}',
          message_type: 'text',
        },
        sender: { sender_id: { open_id: 'ou_test' } },
      };

      await capturedEventHandlers['im.message.receive_v1'](eventData);

      expect(fetch).toHaveBeenCalledWith(
        'http://localhost:3000/api/agent/webhooks/feishu/test_app',
        expect.objectContaining({
          body: expect.any(String),
          headers: { 'Content-Type': 'application/json' },
          method: 'POST',
        }),
      );

      const fetchCall = vi.mocked(fetch).mock.calls[0];
      const body = JSON.parse(fetchCall[1]!.body as string);
      expect(body.schema).toBe('2.0');
      expect(body.header.event_type).toBe('im.message.receive_v1');
      expect(body.event).toEqual(eventData);
    });
  });

  describe('close', () => {
    it('waits for config work started by the SDK reconnect timer and fences the subsequent handshake', async () => {
      let finish!: () => void;
      mockConfig.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = () => resolve({ ok: true });
          }),
      );
      await runWithTenantScope(
        { tenantId: 'a', slug: 'a', session: {} as any, trackWork: () => () => {} },
        async () => {
          const conn = createConnection();
          await conn.start();
          // Real SDK reConnect resolves before this timer body begins.
          await lastClient.reConnect();
          const config = lastClient.pullConnectConfig();
          const done = vi.fn();
          const closing = conn.close().then(done);
          await Promise.resolve();
          expect(done).not.toHaveBeenCalled();
          finish();
          await config;
          expect(await lastClient.connect()).toBe(false);
          await closing;
          expect(mockConnect).not.toHaveBeenCalled();
        },
      );
    });
    it('terminates a handshake that opens after close before completing shutdown', async () => {
      let open!: () => void;
      mockConnect.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            open = () => {
              socket = Object.assign(new EventEmitter(), { readyState: 1 });
              resolve(true);
            };
          }),
      );
      await runWithTenantScope(
        { tenantId: 'a', slug: 'a', session: {} as any, trackWork: () => () => {} },
        async () => {
          const conn = createConnection();
          await conn.start();
          const connecting = lastClient.connect();
          const done = vi.fn();
          const closing = conn.close().then(done);
          open();
          await new Promise((resolve) => setTimeout(resolve, 0));
          expect(mockClose).toHaveBeenCalledTimes(2);
          expect(done).not.toHaveBeenCalled();
          socket!.readyState = 3;
          socket!.emit('close');
          await connecting;
          await closing;
        },
      );
    });
    it('waits for an SDK reconnect already in flight as well as its socket', async () => {
      let finish!: () => void;
      mockReconnect.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      );
      const resources: Promise<void>[] = [];
      await runWithTenantScope(
        {
          tenantId: 'a',
          slug: 'a',
          session: {} as any,
          trackWork: ({ settled }) => {
            resources.push(settled);
            return () => {};
          },
        },
        async () => {
          const conn = createConnection();
          await conn.start();
          socket = Object.assign(new EventEmitter(), { readyState: 1 });
          const reconnect = lastClient.reConnect();
          const done = vi.fn();
          const closing = conn.close().then(done);
          socket.readyState = 3;
          socket.emit('close');
          await Promise.resolve();
          expect(done).not.toHaveBeenCalled();
          finish();
          await reconnect;
          await closing;
          await Promise.all(resources);
          expect(done).toHaveBeenCalledTimes(1);
        },
      );
    });
    it('waits for the actual socket close after SDK force-close', async () => {
      const conn = createConnection();
      await conn.start();
      socket = Object.assign(new EventEmitter(), { readyState: 1 });
      const finished = vi.fn();
      const closing = Promise.resolve(conn.close()).then(finished);
      await Promise.resolve();
      expect(mockClose).toHaveBeenCalledWith({ force: true });
      expect(finished).not.toHaveBeenCalled();
      socket.readyState = 3;
      socket.emit('close');
      await closing;
      expect(finished).toHaveBeenCalledTimes(1);
    });
    it('should call wsClient.close()', async () => {
      const conn = createConnection();
      await conn.start();

      conn.close();
      expect(mockClose).toHaveBeenCalledWith({ force: true });
    });

    it('should be safe to call close() without starting', () => {
      const conn = createConnection();
      conn.close(); // Should not throw
    });
  });
});

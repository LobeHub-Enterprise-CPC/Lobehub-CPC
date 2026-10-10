// @vitest-environment node
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import type * as LarkSDK from '@larksuiteoapi/node-sdk';
import { runWithTenantScope, type TenantScope } from '@lobechat/database/tenant';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';

import { FeishuWSConnection } from './gateway';

const state = vi.hoisted(() => ({ baseURL: '', client: undefined as any }));
vi.mock('@larksuiteoapi/node-sdk', async (original) => {
  const sdk = await original<typeof LarkSDK>();
  return {
    ...sdk,
    WSClient: class extends sdk.WSClient {
      constructor(options: any) {
        super({ ...options, domain: state.baseURL, wsConfig: { handshakeTimeout: 2000 } });
        state.client = this;
      }
    },
  };
});
describe('Feishu official SDK against a local provider', () => {
  let http: Server;
  let ws: WebSocketServer;
  let gateway: FeishuWSConnection;
  afterEach(async () => {
    for (const client of ws?.clients ?? []) client.terminate();
    await gateway?.close();
    ws?.close();
    http?.closeAllConnections();
    await new Promise<void>((resolve) => (http ? http.close(() => resolve()) : resolve()));
  });
  it('waits for an in-flight reconnect config request and prevents a late new socket', async () => {
    let requests = 0;
    let connections = 0;
    let held: ServerResponse | undefined;
    const reply = (res: ServerResponse) =>
      res.end(
        JSON.stringify({
          code: 0,
          data: {
            URL: state.baseURL.replace('http', 'ws') + '/ws?device_id=fixture&service_id=1',
            ClientConfig: {
              PingInterval: 600,
              ReconnectCount: 3,
              ReconnectInterval: 0,
              ReconnectNonce: 0,
            },
          },
        }),
      );
    http = createServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      if (++requests === 1) reply(res);
      else held = res;
    });
    ws = new WebSocketServer({ server: http });
    ws.on('connection', () => {
      connections += 1;
    });
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    state.baseURL = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
    let revoked = false;
    const scope = {
      tenantId: 'fixture',
      slug: 'fixture',
      session: {},
      trackWork: () => {
        if (revoked) throw new Error('TENANT_UNAVAILABLE');
        return () => {};
      },
    } as unknown as TenantScope;
    await runWithTenantScope(scope, async () => {
      gateway = new FeishuWSConnection({
        appId: 'cli_0123456789abcdef',
        appSecret: 'fixture',
        domain: 'feishu',
        webhookUrl: state.baseURL,
      });
      await gateway.start();
      await vi.waitFor(() => expect(connections).toBe(1), { timeout: 3000 });
      for (const client of ws.clients) client.terminate();
      await vi.waitFor(() => expect(held).toBeDefined(), { timeout: 3000 });
      revoked = true;
      let stopped = false;
      const close = gateway.close().then(() => {
        stopped = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(stopped).toBe(false);
      reply(held!);
      await close;
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(connections).toBe(1);
      expect(state.client.wsConfig.getWSInstance()?.readyState ?? 3).toBe(3);
    });
  }, 10000);
});

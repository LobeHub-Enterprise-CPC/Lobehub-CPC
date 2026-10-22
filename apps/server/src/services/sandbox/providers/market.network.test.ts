// @vitest-environment node
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { MarketSDK } from '@lobehub/market-sdk';
import { expect, it } from 'vitest';

import { MarketSandboxProvider } from './market';

it('uses the real Market SDK HTTP protocol and preserves the original instance identity', async () => {
  const bodies: any[] = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    bodies.push({ path: req.url, method: req.method, body: JSON.parse(body) });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ success: true, data: { result: { running: false, exitCode: 0 } } }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const sdk = new MarketSDK({
      baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    });
    const provider = new MarketSandboxProvider({
      marketService: { getSDK: () => sdk },
      userId: 'user-fixture',
      topicId: 'topic-fixture',
      sandboxInstanceId: 'instance-fixture',
      sandboxMode: 'persistent',
      sandboxSpecification: { image: 'fixture' },
    } as any);
    const result = await provider.callTool('getCommandOutput', { commandId: 'command-fixture' });
    expect(result.result?.running).toBe(false);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({
      path: '/api/v1/plugins/run-buildin-tools',
      method: 'POST',
      body: {
        userId: 'user-fixture',
        topicId: 'topic-fixture',
        sandboxInstanceId: 'instance-fixture',
        sandboxMode: 'persistent',
        sandboxSpecification: { image: 'fixture' },
      },
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

// @vitest-environment node
/**
 * Suspending a tenant must stop the model call itself, not only the browser's
 * copy of it. A real local HTTP server plays the provider; the model runtime
 * talks to it over the network exactly as it would to a real one.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { LobeOpenAI } from '@lobechat/model-runtime';
import { afterEach, describe, expect, it } from 'vitest';

import { TenantGateError } from './errors';
import { guardTenantStream, TenantLiveResources } from './liveResources';

const chunk = (content: string) =>
  `data: ${JSON.stringify({
    choices: [{ delta: { content }, finish_reason: null, index: 0 }],
    created: 1,
    id: 'c1',
    model: 'gpt-test',
    object: 'chat.completion.chunk',
  })}\n\n`;

describe('tenant suspension of a model stream', () => {
  let server: Server | undefined;
  afterEach(
    () => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())),
  );

  it('closes the upstream provider connection', async () => {
    let upstream!: IncomingMessage;
    let upstreamClosed!: () => void;
    const closed = new Promise<void>((resolve) => (upstreamClosed = resolve));
    let ticker: ReturnType<typeof setInterval> | undefined;
    server = createServer((req, res) => {
      upstream = req;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      // An endless generation: only a cancelled request ends it.
      ticker = setInterval(() => res.write(chunk('x')), 20);
      res.on('close', () => {
        clearInterval(ticker);
        upstreamClosed();
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    const runtime = new LobeOpenAI({ apiKey: 'test', baseURL: `http://127.0.0.1:${port}/v1` });
    const response = await runtime.chat({
      messages: [{ content: 'hi', role: 'user' }],
      model: 'gpt-test',
      stream: true,
      temperature: 0,
    });

    const live = new TenantLiveResources(async () => {}, 60_000);
    const reader = guardTenantStream(live, 't-1', response.body!).getReader();
    expect((await reader.read()).done).toBe(false);
    expect(upstream.destroyed).toBe(false);

    await live.suspend('t-1', new TenantGateError('TENANT_FROZEN'));

    await expect(reader.read()).rejects.toMatchObject({ code: 'TENANT_FROZEN' });
    await Promise.race([
      closed,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('upstream still open after 2s')), 2000),
      ),
    ]);
  });
});

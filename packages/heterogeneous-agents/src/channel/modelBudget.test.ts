// @vitest-environment node
import { createServer } from 'node:http';

import { describe, expect, it } from 'vitest';

import { createChannelModelBudget } from './modelBudget';

describe('Channel model request budget', () => {
  it('forwards 32 attempts and blocks concurrent overflow before it reaches the provider', async () => {
    const received: string[] = [];
    const upstream = createServer((req, res) => {
      received.push(req.url!);
      res.end('real upstream');
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const address = upstream.address() as { port: number };
    const counts: number[] = [];
    const errors: Error[] = [];
    const proxy = await createChannelModelBudget({
      upstream: `http://127.0.0.1:${address.port}/v1`,
      limit: 32,
      onCall: async (count) => {
        counts.push(count);
      },
      onLimit: (error) => {
        errors.push(error);
      },
    });
    try {
      expect((await fetch(proxy.url + '/models')).status).toBe(200);
      const responses = await Promise.all(
        Array.from({ length: 34 }, () =>
          fetch(proxy.url + '/responses', { method: 'POST', body: '{}' }),
        ),
      );
      expect(responses.filter((response) => response.status === 200)).toHaveLength(32);
      expect(responses.filter((response) => response.status === 429)).toHaveLength(2);
      expect(received.filter((url) => url === '/v1/responses')).toHaveLength(32);
      expect(counts).toEqual(Array.from({ length: 32 }, (_, index) => index + 1));
      expect(errors).toHaveLength(2);
      expect((await fetch(new URL('/responses', proxy.url))).status).toBe(404);
    } finally {
      await proxy.close();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });
});

it('withholds the 65th streamed tool call from the native executor', async () => {
  const upstream = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (let i = 1; i <= 65; i++)
      res.write(
        `data: ${JSON.stringify({ type: 'response.output_item.added', item: { id: `call-${i}`, type: 'function_call', name: 'exec_command' } })}\n\n`,
      );
    res.end();
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address() as { port: number };
  const reserved: number[] = [],
    errors: string[] = [];
  const proxy = await createChannelModelBudget({
    upstream: `http://127.0.0.1:${address.port}`,
    limit: 32,
    toolLimit: 64,
    onCall: async () => {},
    onTool: async (count) => {
      reserved.push(count);
    },
    onLimit: (error) => {
      errors.push(error.message);
    },
  });
  try {
    let text = '';
    try {
      const response = await fetch(proxy.url + '/responses', { method: 'POST' });
      for await (const chunk of response.body!) text += new TextDecoder().decode(chunk);
    } catch {
      /* The over-budget stream is deliberately aborted. */
    }
    expect(reserved).toHaveLength(64);
    expect(text).not.toContain('call-65');
    expect(errors).toEqual(['Channel tool call limit reached']);
  } finally {
    await proxy.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});

it('does not report a budget violation when the native client stops reading a stream', async () => {
  const upstream = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(
      'data: {"type":"response.output_item.added","item":{"id":"call-1","type":"function_call"}}\n\n',
    );
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address() as { port: number };
  const errors: Error[] = [];
  const proxy = await createChannelModelBudget({
    upstream: `http://127.0.0.1:${address.port}`,
    limit: 32,
    toolLimit: 64,
    onCall: async () => {},
    onTool: async () => {},
    onLimit: (error) => {
      errors.push(error);
    },
  });
  try {
    const response = await fetch(proxy.url + '/responses', { method: 'POST' });
    const reader = response.body!.getReader();
    expect((await reader.read()).value).toBeDefined();
    await reader.cancel();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(errors).toEqual([]);
  } finally {
    await proxy.close();
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});

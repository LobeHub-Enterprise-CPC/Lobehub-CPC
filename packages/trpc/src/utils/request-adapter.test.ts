import { initTRPC } from '@trpc/server';
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { NextRequest } from 'next/server';
import { expect, it } from 'vitest';

import { prepareRequestForTRPC } from './request-adapter';

const t = initTRPC.create();
const router = t.router({ ping: t.procedure.query(() => 'pong') });

it.each(['lambda', 'async', 'mobile', 'tools'])(
  'dispatches the real tRPC procedure beneath a tenant %s mount',
  async (mount) => {
    const request = new NextRequest(`http://localhost/t/acme/trpc/${mount}/ping`);
    const response = await fetchRequestHandler({
      createContext: () => ({}),
      endpoint: `/trpc/${mount}`,
      req: prepareRequestForTRPC(request),
      router,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ result: { data: 'pong' } });
    expect(new URL(request.url).pathname).toBe(`/t/acme/trpc/${mount}/ping`);
  },
);

it('preserves query, headers and independent POST body while normalizing the URL', async () => {
  const request = new NextRequest('http://localhost/t/acme/trpc/lambda/ping?batch=1', {
    body: '{"value":1}',
    headers: { 'content-type': 'application/json', 'x-request-id': 'request-1' },
    method: 'POST',
  });
  const prepared = prepareRequestForTRPC(request);
  expect(prepared.url).toBe('http://localhost/trpc/lambda/ping?batch=1');
  expect(prepared.headers.get('x-request-id')).toBe('request-1');
  expect(prepared.method).toBe('POST');
  expect(await prepared.json()).toEqual({ value: 1 });
  expect(await request.json()).toEqual({ value: 1 });
});

it('preserves an already rewritten request', () => {
  const request = new NextRequest('http://localhost/trpc/lambda/ping');
  expect(prepareRequestForTRPC(request).url).toBe(request.url);
});

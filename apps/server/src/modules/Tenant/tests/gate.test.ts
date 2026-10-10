// @vitest-environment node
import { initTRPC } from '@trpc/server';
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TenantGateError } from '../errors';
import { withTenantRequest } from '../gate';
import { getTenantLiveResources } from '../liveResources';
import { signTenantRoute, TENANT_ROUTE_HEADER } from '../routeHeader';

const mocks = vi.hoisted(() => ({ enterSlug: vi.fn() }));

vi.mock('../postgresClaims', () => ({
  heartbeatTenantProcess: vi.fn(),
  tenantClaims: { bind: () => async () => {}, enter: async () => async () => {} },
}));

vi.mock('../runtime', () => ({
  getTenantRuntime: () => mocks,
}));

// The global test setup replaces the gate with a pass-through; use the real one.
vi.mock('@/server/modules/Tenant/gate', async (importOriginal) => importOriginal());

process.env.KEY_VAULTS_SECRET ??= 'gate-test-secret';

const routed = () =>
  new Request('http://localhost/api/agent/stream', {
    headers: { [TENANT_ROUTE_HEADER]: signTenantRoute('acme')! },
  });

describe('withTenantRequest', () => {
  it('preserves framework request proxies, body and extensions', async () => {
    mocks.enterSlug.mockResolvedValue({
      release: async () => {},
      scope: { session: {}, slug: 'acme', tenantId: 't-proxy' },
    });
    const original = new Request('http://localhost/t/acme/api', {
      method: 'POST',
      body: '{"ok":true}',
      headers: { [TENANT_ROUTE_HEADER]: signTenantRoute('acme')! },
    });
    Object.defineProperty(original, 'nextUrl', { value: new URL(original.url) });
    const frameworkRequest = new Proxy(original, {
      get(target, key) {
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const handler = withTenantRequest(async (request) => {
      expect((request as any).nextUrl.pathname).toBe('/api');
      expect(request.url).toBe('http://localhost/api');
      const clone = request.clone();
      expect(clone.url).toBe(request.url);
      expect(clone.signal).toBe(request.signal);
      expect(await clone.json()).toEqual({ ok: true });
      expect(await request.json()).toEqual({ ok: true });
      return new Response(null, { status: 204 });
    });
    expect((await handler(frameworkRequest)).status).toBe(204);
  });
  it('fails a streaming response when its tenant is frozen and stops the handler stream', async () => {
    mocks.enterSlug.mockResolvedValue({
      release: async () => {},
      scope: { session: {}, slug: 'acme', tenantId: 't-acme' },
    });
    const cancelled = vi.fn();
    const handler = withTenantRequest(
      async () =>
        new Response(new ReadableStream({ cancel: cancelled }), {
          headers: { 'content-type': 'text/event-stream' },
        }),
    );

    const response = await handler(routed());
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    const pending = response.body!.getReader().read();

    await getTenantLiveResources().suspend('t-acme', new TenantGateError('TENANT_FROZEN'));

    await expect(pending).rejects.toMatchObject({ code: 'TENANT_FROZEN' });
    expect(cancelled).toHaveBeenCalled();
  });

  it('cancels a handler before headers exist and waits for its cleanup', async () => {
    const release = vi.fn(async () => {});
    mocks.enterSlug.mockResolvedValue({
      release,
      scope: { session: {}, slug: 'acme', tenantId: 't-handler' },
    });
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    let finish!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let signal!: AbortSignal;
    const handler = withTenantRequest(async (request) => {
      signal = request.signal;
      started();
      await cleanup;
      return new Response(null, { status: 204 });
    });
    const response = handler(routed());
    await ready;
    let acknowledged = false;
    const stopping = getTenantLiveResources()
      .suspend('t-handler', new TenantGateError('TENANT_FROZEN'))
      .then(() => {
        acknowledged = true;
      });
    await vi.waitFor(() => expect(signal.aborted).toBe(true));
    expect(acknowledged).toBe(false);
    expect(release).not.toHaveBeenCalled();
    finish();
    expect((await response).status).toBe(204);
    await stopping;
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('answers a refusal raised inside a database driver with the gate response', async () => {
    mocks.enterSlug.mockResolvedValue({
      release: async () => {},
      scope: { session: {}, slug: 'acme', tenantId: 't-acme' },
    });
    const handler = withTenantRequest(async () => {
      throw Object.assign(new Error('Failed query'), {
        cause: new TenantGateError('TENANT_OFFLINE'),
      });
    });
    const response = await handler(routed());
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ code: 'TENANT_OFFLINE' });
  });
});

const headers = () => ({ [TENANT_ROUTE_HEADER]: signTenantRoute('acme')! });
beforeEach(() => {
  mocks.enterSlug.mockImplementation(async (slug: string) => ({
    release: async () => {},
    scope: { slug, tenantId: 'tenant-test' },
  }));
});
describe('tenant request routing', () => {
  it('dispatches the real tRPC procedure from a Next request retaining its tenant URL', async () => {
    const trpc = initTRPC.create();
    const router = trpc.router({ ping: trpc.procedure.query(() => 'pong') });
    const handler = withTenantRequest((req: Request) =>
      fetchRequestHandler({ createContext: () => ({}), endpoint: '/trpc/lambda', req, router }),
    );
    const response = await handler(
      new NextRequest('https://app.test/t/acme/trpc/lambda/ping', { headers: headers() }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ result: { data: 'pong' } });
  });

  it('preserves NextRequest cookies, query, method and streamed body', async () => {
    const handler = withTenantRequest(async (req: NextRequest) =>
      Response.json({
        body: await req.json(),
        cookie: req.cookies.get('session')?.value,
        method: req.method,
        path: req.nextUrl.pathname,
        query: req.nextUrl.search,
      }),
    );
    const response = await handler(
      new NextRequest('https://app.test/t/acme/api/test?x=1', {
        body: JSON.stringify({ value: 1 }),
        headers: { ...headers(), cookie: 'session=value' },
        method: 'POST',
      }),
    );
    expect(await response.json()).toEqual({
      body: { value: 1 },
      cookie: 'value',
      method: 'POST',
      path: '/api/test',
      query: '?x=1',
    });
  });

  it('refuses requests without the signed routing header', async () => {
    const handler = vi.fn(() => Response.json({ ok: true }));
    const response = await withTenantRequest(handler)(
      new Request('https://app.test/t/acme/api/test'),
    );
    expect(response.status).toBe(400);
    expect(handler).not.toHaveBeenCalled();
  });
});

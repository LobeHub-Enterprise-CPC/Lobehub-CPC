// @vitest-environment node
import { initTRPC } from '@trpc/server';
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { withTenantRequest } from './gate';
import { signTenantRoute, TENANT_ROUTE_HEADER } from './routeHeader';

vi.unmock('@/server/modules/Tenant/gate');
vi.mock('./runtime', () => ({
  getTenantRuntime: () => ({
    admitSlug: async (slug: string) => ({ slug, tenantId: 'tenant-test' }),
  }),
}));

const headers = () => ({ [TENANT_ROUTE_HEADER]: signTenantRoute('acme')! });

beforeEach(() => vi.stubEnv('KEY_VAULTS_SECRET', 'gate-test-secret'));
afterEach(() => vi.unstubAllEnvs());

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

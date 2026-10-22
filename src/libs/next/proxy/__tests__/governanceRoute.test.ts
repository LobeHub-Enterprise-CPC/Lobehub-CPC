// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { resolveTenantRoute } from '../tenantRouting';

vi.mock('@/envs/app', () => ({ appEnv: {} }));
// Restore the real gate (the suite setup replaces it); the runtime behind it is never reached.
vi.mock('@/server/modules/Tenant/gate', async (importOriginal) => importOriginal());
vi.mock('@/server/modules/Tenant/runtime', () => ({
  getTenantRuntime: () => ({ enterSlug: vi.fn() }),
}));
vi.mock('@/server/router-hono/governance', () => ({
  default: { fetch: vi.fn(async () => Response.json({ allowed: true })) },
}));

/**
 * The contract Market's sandbox relies on to ask CPC whether a command may run
 * (`POST /api/governance/{check,log}`, service token). There is no tenantless entry: a call
 * names its tenant with the `/t/{slug}` prefix like every other backend path, and a call without
 * it is refused. Market must therefore address `<CPC origin>/t/<slug>/api/governance/...` and treat
 * any non-2xx answer as "not allowed" (fail closed).
 */
describe('governance endpoints are addressed per tenant', () => {
  it.each(['check', 'log', 'rules', 'logs'])(
    '/t/acme/api/governance/%s is routed to the acme tenant',
    (endpoint) => {
      expect(
        resolveTenantRoute(new URL(`https://work.example.com/t/acme/api/governance/${endpoint}`)),
      ).toEqual({
        kind: 'tenant-backend',
        path: `/api/governance/${endpoint}`,
        slug: 'acme',
      });
    },
  );

  it.each(['check', 'log'])(
    '/api/governance/%s without a tenant is a 400 TENANT_REQUIRED',
    (endpoint) => {
      expect(
        resolveTenantRoute(new URL(`https://work.example.com/api/governance/${endpoint}`)),
      ).toEqual({
        code: 'TENANT_REQUIRED',
        kind: 'reject',
        status: 400,
      });
    },
  );

  it('refuses a malformed tenant prefix with 400, not a tenantless pass', () => {
    expect(
      resolveTenantRoute(new URL('https://work.example.com/t/A_B/api/governance/check')),
    ).toMatchObject({
      kind: 'reject',
      status: 400,
    });
  });
});

describe('governance route handler', () => {
  it('refuses a request that the proxy did not route to a tenant', async () => {
    const { POST } = await import('@/app/(backend)/api/governance/[[...route]]/route');

    const response = await POST(
      new Request('https://work.example.com/api/governance/check', {
        body: '{}',
        headers: {
          // A client-supplied route header is never trusted without the proxy's MAC.
          'authorization': 'Bearer service-token',
          'x-lobe-tenant-route': 'acme.forged',
        },
        method: 'POST',
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'TENANT_REQUIRED' });
  });
});

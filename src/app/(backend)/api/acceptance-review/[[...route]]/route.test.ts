// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DELETE, GET, OPTIONS, PATCH, POST } from './route';

const { admitted, fetchApp } = vi.hoisted(() => ({
  admitted: vi.fn(),
  fetchApp: vi.fn(async () => new Response('ok')),
}));

vi.mock('@/server/modules/Tenant/gate', () => ({
  withTenantRequest:
    <Args extends unknown[]>(handler: (...args: Args) => Promise<Response>) =>
    (...args: Args) => {
      admitted();
      return handler(...args);
    },
}));
vi.mock('@/server/router-hono/acceptance-review', () => ({ default: { fetch: fetchApp } }));

const request = (method: string) =>
  new Request('http://localhost/api/acceptance-review/v1/session', { method });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('acceptance-review route', () => {
  // The review auth verifies a token bound to the current tenant and reads that tenant's
  // database, so every data request has to run inside the tenant scope.
  it.each([
    ['GET', GET],
    ['POST', POST],
    ['PATCH', PATCH],
    ['DELETE', DELETE],
  ])('runs %s inside the tenant scope', async (method, handler) => {
    await handler(request(method));

    expect(admitted).toHaveBeenCalledTimes(1);
    expect(fetchApp).toHaveBeenCalledTimes(1);
  });

  it('answers a CORS preflight without entering the tenant', async () => {
    await OPTIONS(request('OPTIONS'));

    expect(admitted).not.toHaveBeenCalled();
    expect(fetchApp).toHaveBeenCalledTimes(1);
  });
});

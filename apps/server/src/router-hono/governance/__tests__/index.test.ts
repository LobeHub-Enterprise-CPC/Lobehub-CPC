// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  appEnv: {} as { COMMAND_GOVERNANCE_SERVICE_TOKEN?: string },
  check: vi.fn((c: { json: (body: object) => Response }) => c.json({ allowed: true })),
}));

vi.mock('@/envs/app', () => ({ appEnv: mocks.appEnv }));
vi.mock('../handlers/check', () => ({ check: mocks.check }));

const app = (await import('../index')).default;

const postCheck = (authorization?: string) =>
  app.request('/api/governance/check', {
    body: '{}',
    headers: authorization ? { authorization } : undefined,
    method: 'POST',
  });

beforeEach(() => {
  mocks.check.mockClear();
  mocks.appEnv.COMMAND_GOVERNANCE_SERVICE_TOKEN = 'service-token';
});

afterEach(() => {
  delete mocks.appEnv.COMMAND_GOVERNANCE_SERVICE_TOKEN;
});

/**
 * Routing admission (which internal host and tenant a request reaches) lives in
 * `apps/server/src/modules/Tenant/hostRouting.test.ts`. This file covers the
 * handler-level boundary behind it: the mounted governance Hono app admits a
 * valid service token and refuses a missing/mismatched one or missing config
 * before any handler runs.
 */
describe('governance service-token auth on the internal route', () => {
  it('admits a request with the configured bearer token', async () => {
    const response = await postCheck('Bearer service-token');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ allowed: true });
    expect(mocks.check).toHaveBeenCalledTimes(1);
  });

  it('returns 401 when the authorization header is missing', async () => {
    const response = await postCheck();

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
    expect(mocks.check).not.toHaveBeenCalled();
  });

  it('returns 401 when the bearer token does not match', async () => {
    const response = await postCheck('Bearer wrong-token');

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
    expect(mocks.check).not.toHaveBeenCalled();
  });

  it('returns 503 when the service token is not configured', async () => {
    delete mocks.appEnv.COMMAND_GOVERNANCE_SERVICE_TOKEN;
    const response = await postCheck('Bearer service-token');

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: 'Service not configured' });
    expect(mocks.check).not.toHaveBeenCalled();
  });

  it('guards every registered governance route before its handler runs', async () => {
    for (const [method, path] of [
      ['POST', '/api/governance/check'],
      ['POST', '/api/governance/log'],
      ['GET', '/api/governance/rules'],
      ['POST', '/api/governance/rules'],
      ['PUT', '/api/governance/rules/rule-1'],
      ['DELETE', '/api/governance/rules/rule-1'],
      ['GET', '/api/governance/logs'],
      ['GET', '/api/governance/execution-policy'],
      ['GET', '/api/governance/execution-policy/user-1'],
      ['PUT', '/api/governance/execution-policy/user-1'],
      ['DELETE', '/api/governance/execution-policy/user-1'],
    ] as const) {
      const response = await app.request(path, { method });
      expect(response.status).toBe(401);
    }
  });
});

import { describe, expect, it, vi } from 'vitest';

import { createGatewayInternalApp } from './index';

const boundaries = vi.hoisted(() => ({
  run: vi.fn(async (_id, fn) => fn()),
  admission: vi.fn(),
  authorize: vi.fn(),
  callback: vi.fn(),
  finalize: vi.fn(),
}));
vi.mock('@/envs/app', () => ({ appEnv: { AGENT_GATEWAY_SERVICE_TOKEN: 'TEST-ONLY-SERVICE' } }));
vi.mock('@/envs/gateway', () => ({ gatewayEnv: {} }));
vi.mock('@/server/services/gatewayAuthorization/authorize', () => ({
  authorizeGateway: boundaries.authorize,
}));
vi.mock('@/server/services/gatewayAuthorization/attempts', () => ({
  acceptGatewayCallback: boundaries.callback,
}));
vi.mock('@/server/services/gatewayAuthorization/finalize', () => ({
  finalizeGatewayOperation: boundaries.finalize,
}));
vi.mock('@/server/modules/Tenant/runtime', () => ({
  getTenantRuntime: () => ({ gatewayAdmission: boundaries.admission }),
}));

vi.mock('../acceptance-review', () => ({
  default: { fetch: () => new Response(null, { status: 404 }) },
}));

const request = (
  path: string,
  options: {
    auth?: string;
    tenant?: string;
    protocol?: string;
    body?: unknown;
    version?: string;
  } = {},
) =>
  new Request(`http://work.invalid/api/internal/gateway/${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(options.auth ? { Authorization: `Bearer ${options.auth}` } : {}),
      'X-LobeHub-Tenant-Id': options.tenant ?? 'tenant-A',
      'X-LobeHub-Gateway-Tenancy': options.protocol ?? '1',
      ...(options.version ? { 'X-LobeHub-Tenant-Version': options.version } : {}),
    },
    body: JSON.stringify(options.body ?? { tenancyProtocol: 1, tenantId: 'tenant-A' }),
  });

describe('gateway root authentication and tenant admission', () => {
  const app = createGatewayInternalApp({
    serviceTokens: () => ['TEST-ONLY-SERVICE'],
    run: boundaries.run,
  });
  it.each(['authorize', 'tool-result', 'finalize-abandoned'])(
    'rejects device credentials for agent-only work on %s before executing it',
    async (path) => {
      const isolated = createGatewayInternalApp({
        serviceTokens: () => ['agent-secret', 'device-secret'],
        run: boundaries.run,
      });
      boundaries.run.mockClear();
      const response = await isolated.fetch(
        request(path, {
          auth: 'device-secret',
          body: { tenancyProtocol: 1, tenantId: 'tenant-A', audience: 'urn:lobehub:gateway:agent' },
        }),
      );
      expect(response.status).toBe(403);
      expect(boundaries.run).not.toHaveBeenCalled();
    },
  );
  it('allows device authorization only with the device token and matching audience', async () => {
    const isolated = createGatewayInternalApp({
      serviceTokens: () => ['agent-secret', 'device-secret'],
      run: boundaries.run,
    });
    const body = {
      tenancyProtocol: 1,
      tenantId: 'tenant-A',
      authorizationId: 'auth-device',
      expectedPrincipal: { kind: 'user', id: 'user' },
      audience: 'urn:lobehub:gateway:device',
      action: 'connect',
      ticket: 'test-only',
      generation: 1,
      requestSeq: 1,
    };
    boundaries.authorize.mockResolvedValue({ allowed: true });
    const authorized = await isolated.fetch(request('authorize', { auth: 'device-secret', body }));
    expect(authorized.status).toBe(200);
    boundaries.run.mockClear();
    const denied = await isolated.fetch(request('authorize', { auth: 'agent-secret', body }));
    expect(denied.status).toBe(403);
    expect(boundaries.run).not.toHaveBeenCalled();
  });

  it('fails closed if the two service audiences use the same credential', async () => {
    const isolated = createGatewayInternalApp({ serviceTokens: () => ['shared', 'shared'] });
    const response = await isolated.fetch(request('admission', { auth: 'shared' }));
    expect(response.status).toBe(503);
  });

  it('rejects a forged tid before consulting platform or tenant business state', async () => {
    boundaries.run.mockClear();
    boundaries.admission.mockClear();
    const response = await app.fetch(request('admission', { auth: 'wrong', tenant: 'victim' }));
    expect(response.status).toBe(401);
    expect(boundaries.admission).not.toHaveBeenCalled();
    expect(boundaries.run).not.toHaveBeenCalled();
  });
  it('reads frozen admission facts without entering a tenant business database', async () => {
    boundaries.admission.mockResolvedValueOnce({
      tenantId: 'tenant-A',
      acceptedVersion: 8,
      effectiveState: 'frozen',
      checkedAt: 1,
      leaseExpiresAt: 30001,
    });
    boundaries.run.mockClear();
    const response = await app.fetch(request('admission', { auth: 'TEST-ONLY-SERVICE' }));
    expect(await response.json()).toMatchObject({ effectiveState: 'frozen' });
    expect(response.headers.get('X-LobeHub-Tenant-Id')).toBe('tenant-A');
    expect(boundaries.run).not.toHaveBeenCalled();
  });
  it.each(['tenant-A,tenant-B', '', 'wrong tenant'])(
    'refuses ambiguous/malformed tenant headers: %s',
    async (tenant) => {
      boundaries.run.mockClear();
      const response = await app.fetch(request('admission', { auth: 'TEST-ONLY-SERVICE', tenant }));
      expect(response.status).toBe(400);
      expect(boundaries.run).not.toHaveBeenCalled();
    },
  );
  it('does not trust a conflicting JSON tenant', async () => {
    const response = await app.fetch(
      request('admission', {
        auth: 'TEST-ONLY-SERVICE',
        body: { tenancyProtocol: 1, tenantId: 'tenant-B' },
      }),
    );
    expect(response.status).toBe(403);
  });
  it('wires both the actual Next shell and Hono mount with service authentication first', async () => {
    const [{ POST }, { default: hono }] = await Promise.all([
      import('../../../../../src/app/(backend)/api/internal/gateway/[[...route]]/route'),
      import('../index'),
    ]);
    const [next, standalone] = await Promise.all([
      POST(request('admission', { auth: 'wrong' })),
      hono.fetch(request('admission', { auth: 'wrong' })),
    ]);
    expect([next.status, standalone.status]).toEqual([401, 401]);
  });
});

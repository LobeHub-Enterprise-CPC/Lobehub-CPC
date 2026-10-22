// @vitest-environment node
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { POST } from '@/app/(backend)/api/internal/gateway/[[...route]]/route';
import { TenantGateError } from '@/server/modules/Tenant/errors';

import { defineConfig } from '../define-config';

const boundary = vi.hoisted(() => ({
  admission: vi.fn(),
  authorize: vi.fn(),
  callback: vi.fn(),
  finalize: vi.fn(),
  enterTenantId: vi.fn(),
  enterSlug: vi.fn(),
  release: vi.fn(),
  findHost: vi.fn(),
  findSlug: vi.fn(),
}));

vi.mock('@/envs/app', () => ({ appEnv: { AGENT_GATEWAY_SERVICE_TOKEN: 'TEST-ONLY-SERVICE' } }));
vi.mock('@/envs/gateway', () => ({
  gatewayEnv: { DEVICE_GATEWAY_SERVICE_TOKEN: 'TEST-ONLY-DEVICE-SERVICE' },
}));
vi.mock('@/envs/auth', () => ({ authEnv: {} }));
vi.mock('@/server/modules/Tenant/endpoints', () => ({
  endpointHosts: () => ({ appUrl: 'http://localhost:3010', internalUrl: 'http://internal:3210' }),
  findHostEndpoint: boundary.findHost,
  findSlugEndpoint: boundary.findSlug,
  getTenantEndpoints: () => ({ get: vi.fn() }),
}));
vi.mock('@/server/modules/Tenant/runtime', () => ({
  getTenantRuntime: () => ({
    gatewayAdmission: boundary.admission,
    enterTenantId: boundary.enterTenantId,
    enterSlug: boundary.enterSlug,
  }),
}));
// Restore the real gate: only its platform/tenant resource boundaries are isolated.
vi.mock('@/server/modules/Tenant/gate', async (importOriginal) => importOriginal());
vi.mock('@/server/modules/Tenant/postgresClaims', () => ({
  heartbeatTenantProcess: vi.fn(),
  tenantClaims: { bind: () => async () => {}, enter: async () => async () => {} },
}));
vi.mock('@/server/services/tenantDiscovery/desktop', () => ({ selectDesktopTenant: vi.fn() }));
vi.mock('@/server/services/gatewayAuthorization/authorize', () => ({
  authorizeGateway: boundary.authorize,
}));
vi.mock('@/server/services/gatewayAuthorization/attempts', () => ({
  acceptGatewayCallback: boundary.callback,
}));
vi.mock('@/server/services/gatewayAuthorization/finalize', () => ({
  finalizeGatewayOperation: boundary.finalize,
}));

const admissionBody = { tenancyProtocol: 1, tenantId: 'tenant-A' };
// The body names the device audience, so it must be sent with the device service token.
const deviceAuthorization = { authorization: 'Bearer TEST-ONLY-DEVICE-SERVICE' };
const authorizeBody = {
  ...admissionBody,
  action: 'renew',
  authorizationId: 'authorization-A',
  audience: 'urn:lobehub:gateway:device',
  expectedPrincipal: { kind: 'user', id: 'user-A' },
  generation: 1,
  requestSeq: 1,
  ticket: 'test-ticket',
  sourceAcceptedVersion: 8,
};

// Emulate Next's request-header handoff after the real proxy allows a request,
// then invoke the actual Next route shell and its independently authenticated Hono handler.
const throughProxy = async (
  path = 'admission',
  headers: Record<string, string | null> = {},
  body: unknown = admissionBody,
) => {
  const requestHeaders = new Headers({
    'host': 'internal:3210',
    'content-type': 'application/json',
    'authorization': 'Bearer TEST-ONLY-SERVICE',
    'x-lobehub-tenant-id': 'tenant-A',
    'x-lobehub-gateway-tenancy': '1',
    'x-lobehub-tenant-version': '8',
  });
  for (const [key, value] of Object.entries(headers))
    if (value === null) requestHeaders.delete(key);
    else requestHeaders.set(key, value);
  const request = new NextRequest(`http://localhost:3010/api/internal/gateway/${path}`, {
    method: 'POST',
    headers: requestHeaders,
    body: JSON.stringify(body),
  });
  const decision = await defineConfig().middleware(request);
  if (decision.headers.get('x-middleware-next') !== '1') return decision;
  const forwarded = new Headers();
  for (const key of (decision.headers.get('x-middleware-override-headers') ?? '').split(',')) {
    const value = decision.headers.get(`x-middleware-request-${key.trim()}`);
    if (value !== null) forwarded.set(key.trim(), value);
  }
  return POST(new Request(request, { headers: forwarded }));
};

const expectNoBusinessAccess = () => {
  for (const hook of [
    boundary.admission,
    boundary.enterTenantId,
    boundary.enterSlug,
    boundary.authorize,
    boundary.callback,
    boundary.finalize,
  ])
    expect(hook).not.toHaveBeenCalled();
};

beforeEach(() => {
  vi.clearAllMocks();
  boundary.findHost.mockResolvedValue(null);
  boundary.findSlug.mockResolvedValue(null);
  boundary.release.mockResolvedValue(undefined);
  boundary.enterTenantId.mockResolvedValue({
    scope: { slug: 'acme', tenantId: 'tenant-A', session: {} },
    release: boundary.release,
  });
  boundary.authorize.mockResolvedValue({ tenantId: 'tenant-A', acceptedVersion: 8 });
});

describe('gateway root through the Next Host proxy and formal route handler', () => {
  it.each(['active', 'frozen', 'offline'])(
    'returns %s platform admission on both deployment authorities without tenant admission',
    async (effectiveState) => {
      boundary.admission.mockResolvedValue({
        ...admissionBody,
        acceptedVersion: 8,
        effectiveState,
        checkedAt: 1,
        leaseExpiresAt: 30001,
      });
      for (const host of ['internal:3210', 'localhost:3010']) {
        const response = await throughProxy('admission', { host });
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ tenantId: 'tenant-A', effectiveState });
        expect(response.headers.get('X-LobeHub-Gateway-Tenancy')).toBe('1');
        expect(response.headers.get('X-LobeHub-Tenant-Id')).toBe('tenant-A');
      }
      expect(boundary.admission).toHaveBeenCalledTimes(2);
      expect(boundary.enterTenantId).not.toHaveBeenCalled();
      expect(boundary.findHost).not.toHaveBeenCalled();
      expect(boundary.findSlug).not.toHaveBeenCalled();
    },
  );

  it.each(['admission', 'authorize', 'tool-result', 'finalize-abandoned'])(
    'requires service authentication before state access on %s',
    async (path) => {
      for (const authorization of [null, 'Bearer wrong-service']) {
        const response = await throughProxy(path, { authorization });
        expect(response.status).toBe(401);
        expect(await response.json()).toMatchObject({ error: { code: 'UNAUTHORIZED' } });
        expectNoBusinessAccess();
      }
    },
  );

  it.each([
    [null, 'TENANT_REQUIRED'],
    ['', 'TENANT_REQUIRED'],
    ['tenant A', 'TENANT_INVALID'],
    ['tenant-A,tenant-B', 'TENANT_INVALID'],
  ])('rejects missing or malformed tenant %s before state access', async (tenant, code) => {
    const response = await throughProxy('admission', { 'x-lobehub-tenant-id': tenant });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code } });
    expectNoBusinessAccess();
  });

  it('keeps protocol, JSON tenant and source version validation before side effects', async () => {
    const protocol = await throughProxy('admission', { 'x-lobehub-gateway-tenancy': '2' });
    expect(protocol.status).toBe(426);
    expect(await protocol.json()).toMatchObject({ error: { code: 'GATEWAY_TENANCY_REQUIRED' } });
    const mismatch = await throughProxy(
      'admission',
      {},
      { ...admissionBody, tenantId: 'tenant-B' },
    );
    expect(mismatch.status).toBe(403);
    expect(await mismatch.json()).toMatchObject({ error: { code: 'TENANT_MISMATCH' } });
    const stale = await throughProxy(
      'authorize',
      { ...deviceAuthorization, 'x-lobehub-tenant-version': '7' },
      authorizeBody,
    );
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: { code: 'TENANT_EXECUTION_VERSION_STALE' } });
    expectNoBusinessAccess();
  });

  it('enters and releases the tenant gate for business requests and honors its frozen refusal', async () => {
    const accepted = await throughProxy('authorize', deviceAuthorization, authorizeBody);
    expect(accepted.status).toBe(200);
    expect(boundary.enterTenantId).toHaveBeenCalledWith('tenant-A');
    expect(boundary.authorize).toHaveBeenCalledOnce();
    expect(boundary.release).toHaveBeenCalledOnce();
    boundary.authorize.mockClear();
    boundary.enterTenantId.mockRejectedValueOnce(new TenantGateError('TENANT_FROZEN'));
    const frozen = await throughProxy('authorize', deviceAuthorization, authorizeBody);
    expect(frozen.status).toBe(403);
    expect(await frozen.json()).toMatchObject({ error: { code: 'TENANT_FROZEN' } });
    expect(boundary.authorize).not.toHaveBeenCalled();
  });

  it('keeps the agent and device service tokens to their own audience', async () => {
    const crossed = await throughProxy('authorize', {}, authorizeBody);
    expect(crossed.status).toBe(403);
    expect(await crossed.json()).toMatchObject({ error: { code: 'AUDIENCE_MISMATCH' } });
    const agentOnly = await throughProxy('finalize-abandoned', deviceAuthorization, {});
    expect(agentOnly.status).toBe(403);
    expect(await agentOnly.json()).toMatchObject({ error: { code: 'AUDIENCE_MISMATCH' } });
    expectNoBusinessAccess();
  });

  it.each(['unknown.example.com', 'chat.example.com', 'internal:3211'])(
    'does not let forwarded-host authorize %s',
    async (host) => {
      const response = await throughProxy('admission', {
        host,
        'x-forwarded-host': 'internal:3210',
        'forwarded': 'host=localhost:3010',
      });
      expect(response.status).toBe(404);
      expectNoBusinessAccess();
    },
  );
});

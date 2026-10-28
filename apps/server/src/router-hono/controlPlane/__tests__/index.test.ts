import { LOBEHUB_TENANT_SCHEMA_VERSION } from '@lobechat/database/tenant';
import { describe, expect, it, vi } from 'vitest';

import { parseControlPlaneToken } from '@/server/services/tenantControlPlane/auth';
import {
  redactDatasourceBundle,
  tenantDbNames,
} from '@/server/services/tenantControlPlane/datasource';
import { MemoryControlPlaneRepository } from '@/server/services/tenantControlPlane/memoryRepository';
import { TenantControlPlaneService } from '@/server/services/tenantControlPlane/service';

import { createControlPlaneApp } from '../index';

vi.mock('@/envs/app', () => ({ appEnv: {} }));

const invalidation = vi.hoisted(() => ({ auth: vi.fn(), endpoints: vi.fn(), runtime: vi.fn() }));
vi.mock('@/auth', () => ({ invalidateTenantAuth: invalidation.auth }));
vi.mock('@/server/modules/Tenant/endpointCache', () => ({
  invalidateEndpointRouting: invalidation.endpoints,
}));
vi.mock('@/server/modules/Tenant/runtime', () => ({
  getTenantRuntime: () => ({ invalidate: invalidation.runtime }),
}));

const TOKEN = 't'.repeat(32);
const TENANT = '3f1c9a52-7b4e-4c1d-9e1a-0c2b8d7f6e5a';
const BASE = 'http://lobehub.internal/api/internal/control-plane';
const endpoints = [
  { method: 'POST', path: '/tenant-provision' },
  { method: 'GET', path: '/tenant-provision' },
  { method: 'POST', path: '/tenant-datasource' },
  { method: 'POST', path: '/tenant-readiness' },
  { method: 'POST', path: '/tenant-lifecycle' },
  { method: 'GET', path: '/tenant-lifecycle' },
  { method: 'GET', path: '/tenant-overview' },
  { method: 'POST', path: '/tenant-destruction' },
  { method: 'GET', path: '/tenant-destruction' },
  { method: 'POST', path: '/tenant-profile' },
];

const setup = (configured = true) => {
  const repo = new MemoryControlPlaneRepository();
  const service = new TenantControlPlaneService({
    database: {
      checkOwnership: async () => {},
      migrate: async () => {},
      seed: async () => {},
      verify: async () => {},
      verifyDiscovery: async () => {},
    },
    isRegistrableSlug: (slug) => slug !== 'admin',
    repository: repo,
  });
  const app = createControlPlaneApp({
    tokenDigest: configured ? parseControlPlaneToken(TOKEN) : null,
    service: () => service,
  });
  const call = (path: string, init: RequestInit & { headers?: Record<string, string> } = {}) =>
    app.fetch(
      new Request(`${BASE}${path}`, {
        ...init,
        headers: {
          'authorization': `Bearer ${TOKEN}`,
          'content-type': 'application/json',
          'x-request-id': 'req-1',
          'x-tenant-id': TENANT,
          ...init.headers,
        },
      }),
    );
  return { call, repo, service };
};

const names = tenantDbNames(TENANT);
const datasource = {
  connectionVersion: 1,
  credentialBundleVersion: 1,
  database: 'lobehub',
  datasourceKind: 'lobehub' as const,
  deploymentRef: 'default',
  host: '10.1.2.3',
  mode: 'shared_schema' as const,
  port: 5432,
  runtimeCredential: { password: 'run-secret', username: names.runtimeUsername },
  schemaName: names.schemaName,
  schemaOwner: {
    password: 'owner-secret',
    role: names.ownerUsername,
    username: names.ownerUsername,
  },
  schemaVersion: 1,
  tenantId: TENANT,
  tls: { enabled: false, rejectUnauthorized: false },
};

const provisionBody = {
  datasource,
  name: 'Acme',
  operationId: 'root-1:lobehub',
  rootOperationId: 'root-1',
  slug: 'acme',
  tenantId: TENANT,
};

describe('control-plane router', () => {
  it('serves the schema version it provisions to a caller that names no tenant', async () => {
    const { call } = setup();
    const res = await call('/tenant-manifest');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(await res.json()).toEqual({ schemaVersion: LOBEHUB_TENANT_SCHEMA_VERSION });
  });

  it('refuses the manifest to a wrong token and disables it without one', async () => {
    const { call } = setup();
    expect(
      (await call('/tenant-manifest', { headers: { authorization: 'Bearer nope' } })).status,
    ).toBe(401);
    expect((await setup(false).call('/tenant-manifest')).status).toBe(503);
  });

  it('answers 202 for a received provision, with no-store and the request id', async () => {
    const { call } = setup();
    const res = await call('/tenant-provision', {
      body: JSON.stringify(provisionBody),
      method: 'POST',
    });
    expect(res.status).toBe(202);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('x-request-id')).toBe('req-1');
    expect(await res.json()).toMatchObject({ status: 'received', tenantId: TENANT });
  });

  it('answers 503 with the full result when a POST lands on a failed operation', async () => {
    const { call } = setup();
    const res = await call('/tenant-provision', {
      body: JSON.stringify({ ...provisionBody, slug: 'admin' }),
      method: 'POST',
    });
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toMatch(/^\d+$/);
    expect(await res.json()).toMatchObject({
      code: 'TENANT_INVALID',
      errorCode: 'TENANT_INVALID',
      status: 'failed',
    });
  });

  it.each(endpoints)('refuses a wrong token for $method $path', async ({ method, path }) => {
    const { call } = setup();
    const res = await call(path, {
      headers: { authorization: 'Bearer nope' },
      method,
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ code: 'TOKEN_INVALID' });
  });

  it.each(endpoints)(
    'disables $method $path when no token is configured',
    async ({ method, path }) => {
      const { call } = setup(false);
      expect((await call(path, { method })).status).toBe(503);
    },
  );

  it('never lets the header choose the tenant', async () => {
    const { call } = setup();
    const res = await call('/tenant-provision', {
      body: JSON.stringify(provisionBody),
      headers: { 'x-tenant-id': 'tenant-b' },
      method: 'POST',
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: 'TENANT_MISMATCH' });
  });

  it('rejects unknown fields', async () => {
    const { call } = setup();
    const res = await call('/tenant-provision', {
      body: JSON.stringify({ ...provisionBody, lobehubDatasource: {} }),
      method: 'POST',
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: 'INVALID_INPUT' });
  });

  it('rejects a body over 64 KiB', async () => {
    const { call } = setup();
    const res = await call('/tenant-provision', {
      body: JSON.stringify({ ...provisionBody, name: 'x'.repeat(70_000) }),
      method: 'POST',
    });
    expect(res.status).toBe(413);
  });

  it('answers 404 for an operation it never received, so Console posts it', async () => {
    const { call } = setup();
    const res = await call(`/tenant-provision?tenantId=${TENANT}&operationId=missing`);
    expect(res.status).toBe(404);
  });

  it('no longer serves credentials back to Console', async () => {
    const { call } = setup();
    const res = await call(
      `/tenant-provision/credentials?tenantId=${TENANT}&operationId=x&credentialBundleVersion=1`,
    );
    expect(res.status).toBe(404);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
  });

  it('rejects the retired placementRef field', async () => {
    const { call } = setup();
    const res = await call('/tenant-provision', {
      body: JSON.stringify({ ...provisionBody, placementRef: 'default' }),
      method: 'POST',
    });
    expect(res.status).toBe(400);
  });

  it('fails a bundle with an unsupported schema version with 503 DATASOURCE_INVALID', async () => {
    const { call } = setup();
    const res = await call('/tenant-provision', {
      body: JSON.stringify({
        ...provisionBody,
        datasource: { ...datasource, schemaVersion: 99 },
      }),
      method: 'POST',
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ errorCode: 'DATASOURCE_INVALID', status: 'failed' });
  });

  it('rejects a bundle whose runtime user is the owner', async () => {
    const { call } = setup();
    const res = await call('/tenant-provision', {
      body: JSON.stringify({
        ...provisionBody,
        datasource: {
          ...datasource,
          runtimeCredential: { password: 'x', username: names.ownerUsername },
        },
      }),
      method: 'POST',
    });
    expect(res.status).toBe(400);
  });

  describe('tenant-datasource', () => {
    const rotation = {
      datasource: {
        ...datasource,
        credentialBundleVersion: 2,
        runtimeCredential: { password: 'run-secret-2', username: names.runtimeUsername },
      },
      operationId: 'rot-1',
      tenantId: TENANT,
    };

    it('answers 404 TENANT_NOT_FOUND for a tenant not provisioned', async () => {
      const { call } = setup();
      const res = await call('/tenant-datasource', {
        body: JSON.stringify(rotation),
        method: 'POST',
      });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ code: 'TENANT_NOT_FOUND' });
    });

    it('answers 200 applied, then 409 for a stale version', async () => {
      const { call, service } = setup();
      await call('/tenant-provision', { body: JSON.stringify(provisionBody), method: 'POST' });
      await service.executeProvision(TENANT, 'root-1:lobehub');

      const ok = await call('/tenant-datasource', {
        body: JSON.stringify(rotation),
        method: 'POST',
      });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({
        connectionVersion: 1,
        credentialBundleVersion: 2,
        datasourceKind: 'lobehub' as const,
        diagnosticCode: null,
        errorCode: null,
        operationId: 'rot-1',
        status: 'applied',
        tenantId: TENANT,
      });

      const stale = await call('/tenant-datasource', {
        body: JSON.stringify({ ...rotation, datasource }),
        method: 'POST',
      });
      expect(stale.status).toBe(409);
      expect(await stale.json()).toEqual({ code: 'DATASOURCE_VERSION_CONFLICT' });
    });

    it('answers 503 failed for an invalid bundle', async () => {
      const { call, service } = setup();
      await call('/tenant-provision', { body: JSON.stringify(provisionBody), method: 'POST' });
      await service.executeProvision(TENANT, 'root-1:lobehub');
      const res = await call('/tenant-datasource', {
        body: JSON.stringify({
          ...rotation,
          datasource: { ...rotation.datasource, schemaVersion: 99 },
        }),
        method: 'POST',
      });
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ errorCode: 'DATASOURCE_INVALID', status: 'failed' });
    });

    it('rejects unknown fields', async () => {
      const { call } = setup();
      const res = await call('/tenant-datasource', {
        body: JSON.stringify({ ...rotation, expectedBundleVersion: 1 }),
        method: 'POST',
      });
      expect(res.status).toBe(400);
    });
  });

  it('accepts a lifecycle event and refuses an active event carrying a manual freeze', async () => {
    const { call } = setup();
    await call('/tenant-provision', { body: JSON.stringify(provisionBody), method: 'POST' });
    const event = {
      desiredState: 'frozen',
      eventId: 'evt-1',
      expiresAt: null,
      freezeReasons: ['manual'],
      occurredAt: '2026-10-08T00:00:00.000Z',
      tenantId: TENANT,
      version: 1,
    };
    const ok = await call('/tenant-lifecycle', { body: JSON.stringify(event), method: 'POST' });
    expect(ok.status).toBe(202);

    const bad = await call('/tenant-lifecycle', {
      body: JSON.stringify({ ...event, desiredState: 'active', eventId: 'evt-2', version: 2 }),
      method: 'POST',
    });
    expect(bad.status).toBe(400);
  });
});

describe('tenant-profile', () => {
  const profile = {
    eventId: 'profile:abc',
    formerSlugs: ['acme'],
    name: 'Acme Corp',
    slug: 'acme-corp',
    tenantId: TENANT,
    version: 2,
  };
  const post = (call: ReturnType<typeof setup>['call'], body: unknown) =>
    call('/tenant-profile', { body: JSON.stringify(body), method: 'POST' });
  const provisioned = async () => {
    const context = setup();
    await context.call('/tenant-provision', {
      body: JSON.stringify(provisionBody),
      method: 'POST',
    });
    await context.service.executeProvision(TENANT, 'root-1:lobehub');
    invalidation.auth.mockClear();
    invalidation.endpoints.mockClear();
    invalidation.runtime.mockClear();
    return context;
  };

  it('answers 404 TENANT_NOT_FOUND for a tenant not provisioned here', async () => {
    const res = await post(setup().call, profile);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ code: 'TENANT_NOT_FOUND' });
  });

  it('applies a newer profile, answers the stored values and drops the slug-keyed caches', async () => {
    const { call } = await provisioned();
    const res = await post(call, profile);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(await res.json()).toEqual({
      acceptedVersion: 2,
      appliedVersion: 2,
      errorCode: null,
      eventId: 'profile:abc',
      name: 'Acme Corp',
      observedAt: expect.any(String),
      slug: 'acme-corp',
      status: 'applied',
      tenantId: TENANT,
      version: 2,
    });
    expect(invalidation.auth).toHaveBeenCalledWith(TENANT);
    expect(invalidation.runtime).toHaveBeenCalledWith(TENANT);
    expect(invalidation.endpoints).toHaveBeenCalledTimes(1);

    const overview = await call(`/tenant-overview?tenantId=${TENANT}`);
    expect(await overview.json()).toMatchObject({ slug: 'acme-corp' });
  });

  it('leaves the caches alone for a superseded revision', async () => {
    const { call } = await provisioned();
    await post(call, { ...profile, version: 3 });
    invalidation.auth.mockClear();
    invalidation.endpoints.mockClear();
    invalidation.runtime.mockClear();
    const res = await post(call, {
      ...profile,
      eventId: 'profile:old',
      name: 'Older',
      slug: 'older',
      version: 2,
    });
    expect(await res.json()).toMatchObject({ name: 'Acme Corp', status: 'superseded' });
    expect(invalidation.auth).not.toHaveBeenCalled();
    expect(invalidation.endpoints).not.toHaveBeenCalled();
    expect(invalidation.runtime).not.toHaveBeenCalled();
  });

  it('answers 409 VERSION_CONFLICT for the same version with other content', async () => {
    const { call } = await provisioned();
    await post(call, profile);
    const res = await post(call, { ...profile, name: 'Other' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ code: 'VERSION_CONFLICT' });
  });

  it('answers 409 SLUG_CONFLICT for another tenant slug and drops no cache', async () => {
    const { call, repo } = await provisioned();
    repo.aliases.set('taken', '9b1d4e6f-2222-4333-8444-a55566667777');
    const res = await post(call, { ...profile, slug: 'taken' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ code: 'SLUG_CONFLICT' });
    expect(invalidation.runtime).not.toHaveBeenCalled();
  });

  it.each([
    ['unknown fields', { ...profile, extra: 1 }],
    ['version 1', { ...profile, version: 1 }],
    ['the current slug among the former ones', { ...profile, formerSlugs: ['acme-corp'] }],
    ['a missing alias set', { ...profile, formerSlugs: undefined }],
  ])('rejects %s with 400', async (_label, body) => {
    const res = await post(setup().call, body);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: 'INVALID_INPUT' });
  });

  it('never lets the header choose the tenant', async () => {
    const res = await setup().call('/tenant-profile', {
      body: JSON.stringify(profile),
      headers: { 'x-tenant-id': 'tenant-b' },
      method: 'POST',
    });
    expect(res.status).toBe(403);
  });
});

describe('readiness HTTP contract', () => {
  it('returns current binding verification and never echoes passwords', async () => {
    const { call, service } = setup();
    await call('/tenant-provision', { method: 'POST', body: JSON.stringify(provisionBody) });
    await service.executeProvision(TENANT, provisionBody.operationId);
    const res = await call('/tenant-readiness', {
      method: 'POST',
      body: JSON.stringify({ tenantId: TENANT, datasource: redactDatasourceBundle(datasource) }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    const result = await res.json();
    expect(result).toMatchObject({
      tenantId: TENANT,
      datasourceReady: true,
      errorCode: null,
      connectionVersion: 1,
      credentialBundleVersion: 1,
      schemaName: names.schemaName,
    });
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('rejects credential-bearing readiness requests and mismatched tenant headers', async () => {
    const { call } = setup();
    expect(
      (
        await call('/tenant-readiness', {
          method: 'POST',
          body: JSON.stringify({ tenantId: TENANT, datasource }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call('/tenant-readiness', {
          method: 'POST',
          headers: { 'x-tenant-id': 'other' },
          body: JSON.stringify({
            tenantId: TENANT,
            datasource: redactDatasourceBundle(datasource),
          }),
        })
      ).status,
    ).toBe(403);
  });
});

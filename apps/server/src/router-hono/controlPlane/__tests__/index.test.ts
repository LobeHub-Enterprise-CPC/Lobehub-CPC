import { describe, expect, it, vi } from 'vitest';

import { parseControlPlaneGrants } from '@/server/services/tenantControlPlane/auth';
import { tenantDbNames } from '@/server/services/tenantControlPlane/datasource';
import { MemoryControlPlaneRepository } from '@/server/services/tenantControlPlane/memoryRepository';
import { TenantControlPlaneService } from '@/server/services/tenantControlPlane/service';

import { createControlPlaneApp } from '../index';

vi.mock('@/envs/app', () => ({ appEnv: {} }));

const TOKEN = 't'.repeat(32);
const TENANT = 'tenant-a';
const BASE = 'http://lobehub.internal/api/internal/control-plane';

const setup = (configured = true) => {
  const repo = new MemoryControlPlaneRepository();
  const service = new TenantControlPlaneService({
    database: {
      checkOwnership: async () => {},
      migrate: async () => {},
      seed: async () => {},
      verify: async () => {},
      writeMarker: async () => {},
    },
    isRegistrableSlug: (slug) => slug !== 'admin',
    repository: repo,
  });
  const app = createControlPlaneApp({
    grants: configured ? parseControlPlaneGrants({ LOBEHUB_CONTROL_PLANE_TOKEN: TOKEN }) : null,
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
  datasourceKind: 'lobehub',
  deploymentRef: 'default',
  host: '10.1.2.3',
  mode: 'shared_schema',
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
    expect(await res.json()).toMatchObject({ errorCode: 'TENANT_INVALID', status: 'failed' });
  });

  it('refuses a wrong token with TOKEN_INVALID', async () => {
    const { call } = setup();
    const res = await call('/tenant-overview?tenantId=tenant-a', {
      headers: { authorization: 'Bearer nope' },
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ code: 'TOKEN_INVALID' });
  });

  it('answers 503 when no token is configured', async () => {
    const { call } = setup(false);
    expect((await call('/tenant-overview?tenantId=tenant-a')).status).toBe(503);
  });

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
    const res = await call('/tenant-provision?tenantId=tenant-a&operationId=missing');
    expect(res.status).toBe(404);
  });

  it('no longer serves credentials back to Console', async () => {
    const { call } = setup();
    const res = await call(
      '/tenant-provision/credentials?tenantId=tenant-a&operationId=x&credentialBundleVersion=1',
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
        datasourceKind: 'lobehub',
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

import { describe, expect, it, vi } from 'vitest';

import { bundle, NOW } from '@/server/services/tenantControlPlane/__tests__/service.testUtils';
import { parseControlPlaneToken } from '@/server/services/tenantControlPlane/auth';
import { MemoryControlPlaneRepository } from '@/server/services/tenantControlPlane/memoryRepository';
import { TenantControlPlaneService } from '@/server/services/tenantControlPlane/service';

import { createControlPlaneApp } from '../index';

vi.mock('@/envs/app', () => ({ appEnv: {} }));
const auth = vi.hoisted(() => ({ invalidateTenantAuth: vi.fn() }));
vi.mock('@/auth', () => auth);

const TOKEN = 't'.repeat(32);
const TENANT = '3f1c9a52-7b4e-4c1d-9e1a-0c2b8d7f6e5a';
const OP = 'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f';
const BASE = 'http://lobehub.internal/api/internal/control-plane';

const setup = () => {
  const repo = new MemoryControlPlaneRepository();
  const service = new TenantControlPlaneService({
    database: {
      checkOwnership: async () => {},
      migrate: async () => {},
      seed: async () => {},
      verify: async () => {},
      verifyDiscovery: async () => {},
    },
    destruction: { clock: () => 0, drainBudgetMs: 0, sleep: async () => {} },
    isRegistrableSlug: () => true,
    now: () => NOW,
    repository: repo,
  });
  const app = createControlPlaneApp({
    schedule: vi.fn(),
    service: () => service,
    tokenDigest: parseControlPlaneToken(TOKEN),
  });
  const call = (path: string, init: RequestInit & { headers?: Record<string, string> } = {}) =>
    app.fetch(
      new Request(`${BASE}${path}`, {
        ...init,
        headers: {
          'authorization': `Bearer ${TOKEN}`,
          'content-type': 'application/json',
          'x-tenant-id': TENANT,
          ...init.headers,
        },
      }),
    );
  const post = (phase: string, over: Record<string, unknown> = {}, headers = {}) =>
    call('/tenant-destruction', {
      body: JSON.stringify({ destroyOperationId: OP, phase, tenantId: TENANT, ...over }),
      headers,
      method: 'POST',
    });
  return { call, post, repo, service };
};

describe('POST /tenant-destruction', () => {
  it('answers 200 applied for the barrier, with no-store, and never 202', async () => {
    const { post } = setup();
    const res = await post('barrier');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(await res.json()).toEqual({
      completedAt: null,
      destroyOperationId: OP,
      drainResult: null,
      phase: 'barrier',
      status: 'applied',
      tenantId: TENANT,
      terminalEstablishedAt: NOW.toISOString(),
    });
  });

  it('answers 202 with Retry-After while a runtime process still holds the tenant', async () => {
    const { post, repo } = setup();
    await post('barrier');
    repo.drainBlockers.set(TENANT, { externalWork: false, processes: true });
    const res = await post('drain');
    expect(res.status).toBe(202);
    expect(res.headers.get('retry-after')).toBe('5');
    expect(await res.json()).toMatchObject({ drainResult: null, status: 'applying' });
    repo.drainBlockers.clear();
    expect((await post('drain')).status).toBe(200);
  });

  it("drops this process's admission of the tenant at the barrier and at unregister, not at drain", async () => {
    const { post } = setup();
    auth.invalidateTenantAuth.mockClear();
    await post('barrier');
    expect(auth.invalidateTenantAuth).toHaveBeenCalledTimes(1);
    await post('drain');
    expect(auth.invalidateTenantAuth).toHaveBeenCalledTimes(1);
    await post('unregister');
    expect(auth.invalidateTenantAuth).toHaveBeenCalledWith(TENANT);
    expect(auth.invalidateTenantAuth).toHaveBeenCalledTimes(2);
  });

  it('runs the three phases to completion and replays the unregister as absent with 200', async () => {
    const { post } = setup();
    await post('barrier');
    await post('drain');
    const done = await post('unregister');
    expect(done.status).toBe(200);
    expect(await done.json()).toMatchObject({ completedAt: NOW.toISOString(), status: 'applied' });
    const replay = await post('unregister');
    expect(replay.status).toBe(200);
    const body = await replay.json();
    expect(body).toMatchObject({ status: 'absent', completedAt: NOW.toISOString() });
    expect(body).not.toHaveProperty('items');
  });

  it.each([
    ['unregister without a drain', 'unregister', {}, 'DESTROY_PHASE_ORDER'],
    [
      'another destroyOperationId',
      'barrier',
      { destroyOperationId: '5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d' },
      'OPERATION_CONFLICT',
    ],
  ])('answers 409 for %s', async (_label, phase, over, code) => {
    const { post } = setup();
    if (code === 'OPERATION_CONFLICT') await post('barrier');
    const res = await post(phase, over);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ code });
  });

  it('answers 403 TENANT_MISMATCH when the body and header name different tenants', async () => {
    const { post } = setup();
    const res = await post(
      'barrier',
      {},
      { 'x-tenant-id': '8a6d2f40-1c3b-4e7a-b5d9-6f0e2a4c8b13' },
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: 'TENANT_MISMATCH' });
  });

  it.each([
    ['an unknown phase', { phase: 'purge' }],
    ['a slug', { slug: 'acme' }],
    ['a non-UUID operation id', { destroyOperationId: 'op-1' }],
    ['a non-canonical tenant id', { tenantId: 'ACME' }],
  ])('answers 400 INVALID_INPUT for %s', async (_label, over) => {
    const { post } = setup();
    const res = await post('barrier', over, { 'x-tenant-id': TENANT });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: 'INVALID_INPUT' });
  });

  it('answers 503 TENANT_DESTRUCTION_FAILED with Retry-After for a transient failure', async () => {
    const { post, repo } = setup();
    vi.spyOn(repo, 'transaction').mockRejectedValue(new Error('connection refused'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await post('barrier');
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('5');
    expect(await res.json()).toEqual({ code: 'TENANT_DESTRUCTION_FAILED' });
  });
});

describe('GET /tenant-destruction', () => {
  const query = (over: Record<string, string> = {}) =>
    `/tenant-destruction?${new URLSearchParams({ tenantId: TENANT, ...over })}`;

  it('answers 200 with reached null for a UUID with no terminal, and writes nothing', async () => {
    const { call, repo } = setup();
    const res = await call(query());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      completedAt: null,
      destroyOperationId: null,
      drainResult: null,
      reached: null,
      tenantId: TENANT,
      terminalEstablishedAt: null,
    });
    expect(repo.destructions.size).toBe(0);
  });

  it('follows the destruction and conflicts only for another operation id', async () => {
    const { call, post } = setup();
    await post('barrier');
    expect(await (await call(query({ destroyOperationId: OP }))).json()).toMatchObject({
      reached: 'barrier',
    });
    const other = await call(query({ destroyOperationId: '5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d' }));
    expect(other.status).toBe(409);
    expect(await other.json()).toEqual({ code: 'OPERATION_CONFLICT' });
    expect((await call(query())).status).toBe(200);
  });

  it('requires a tenantId', async () => {
    const { call } = setup();
    const res = await call('/tenant-destruction');
    expect(res.status).toBe(400);
  });
});

describe('the other routes after the barrier', () => {
  it('answers 409 TENANT_DESTROYED to a late provision, lifecycle and overview request', async () => {
    const { call, post } = setup();
    await post('barrier');
    const names = bundle(TENANT);
    const late = [
      call('/tenant-provision', {
        body: JSON.stringify({
          datasource: names,
          name: 'Acme',
          operationId: 'late-op',
          rootOperationId: 'root',
          slug: 'acme',
          tenantId: TENANT,
        }),
        method: 'POST',
      }),
      call('/tenant-lifecycle', {
        body: JSON.stringify({
          desiredState: 'frozen',
          eventId: 'late-evt',
          expiresAt: null,
          freezeReasons: ['manual'],
          occurredAt: NOW.toISOString(),
          tenantId: TENANT,
          version: 1,
        }),
        method: 'POST',
      }),
      call(`/tenant-overview?tenantId=${TENANT}`),
      call(`/tenant-provision?tenantId=${TENANT}&operationId=late-op`),
    ];
    for (const res of await Promise.all(late)) {
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ code: 'TENANT_DESTROYED' });
    }
  });
});

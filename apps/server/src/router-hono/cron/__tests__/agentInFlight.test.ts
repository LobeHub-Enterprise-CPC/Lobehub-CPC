// @vitest-environment node
import type { LobeChatDatabase } from '@lobechat/database';
import { agentOperations } from '@lobechat/database/schemas';
import { currentTenantScope } from '@lobechat/database/tenant';
import { getTestDB } from '@lobechat/database/test-utils';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_STALE_AFTER_MS } from '@/server/services/agentRuntime/StaleOperationReaper';

const NOW = new Date('2026-10-31T02:00:00.000Z');
const SECRET = 'cron-secret';

let tenantADB: LobeChatDatabase;

const mocks = vi.hoisted(() => ({
  enterTenantId: vi.fn(),
  listTenantAvailability: vi.fn(),
  /** Per-tenant database resolver; defaults to the real test database for tenant `t-a`. */
  tenantDB: vi.fn(),
}));

vi.mock('@/database/core/db-adaptor', () => ({
  getServerDB: async () => mocks.tenantDB(currentTenantScope()?.tenantId),
}));
vi.mock('@/server/modules/Tenant/postgresClaims', () => ({
  heartbeatTenantProcess: vi.fn(),
  tenantClaims: { bind: () => async () => {}, enter: async () => async () => {} },
}));
vi.mock('@/server/modules/Tenant/runtime', () => ({ getTenantRuntime: () => mocks }));
// The global test setup replaces the gate with a pass-through; use the real one.
vi.mock('@/server/modules/Tenant/gate', async (importOriginal) => importOriginal());
vi.mock('@/libs/qstash', () => ({ qstashClient: { publishJSON: vi.fn() } }));
vi.mock('@/server/services/gateway/tenantStart', () => ({ startGatewayForAllTenants: vi.fn() }));

const { default: app } = await import('../index');

const ago = (ms: number) => new Date(NOW.getTime() - ms);

/** A tenant database that only answers the in-flight select with fixed rows. */
const fakeTenantDB = (rows: unknown[]) => ({
  select: () => ({ from: () => ({ where: () => ({ orderBy: async () => rows }) }) }),
});

const request = (headers: Record<string, string> = { authorization: `Bearer ${SECRET}` }) =>
  app.request('/api/cron/agent/in-flight', { headers, method: 'GET' });

beforeAll(async () => {
  tenantADB = await getTestDB();
});

beforeEach(async () => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  vi.stubEnv('CRON_SECRET', SECRET);
  vi.clearAllMocks();
  mocks.enterTenantId.mockImplementation(async (tenantId: string) => ({
    release: async () => {},
    scope: { session: {}, slug: tenantId, tenantId },
  }));
  mocks.tenantDB.mockImplementation(async (tenantId?: string) => {
    if (tenantId === 't-a') return tenantADB;
    throw new Error(`no database for ${tenantId}`);
  });
  await tenantADB.delete(agentOperations);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('GET /api/cron/agent/in-flight', () => {
  it('requires the cron bearer secret and reads no tenant without it', async () => {
    const missing = await request({});
    const wrong = await request({ authorization: 'Bearer nope' });

    expect(missing.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(mocks.listTenantAvailability).not.toHaveBeenCalled();
    expect(mocks.enterTenantId).not.toHaveBeenCalled();
  });

  it('counts an operation in flight up to the reaper window boundary, and only live statuses', async () => {
    mocks.listTenantAvailability.mockResolvedValue([{ tenantId: 't-a' }]);
    const base = { userId: 'u1' };
    await tenantADB.insert(agentOperations).values([
      {
        ...base,
        createdAt: ago(20 * 60_000),
        id: 'op-boundary',
        status: 'running',
        stepCount: 4,
        trigger: 'chat',
        updatedAt: ago(DEFAULT_STALE_AFTER_MS),
      },
      {
        ...base,
        createdAt: ago(60_000),
        id: 'op-idle',
        parentOperationId: 'op-boundary',
        status: 'idle',
        updatedAt: ago(30_000),
      },
      // One millisecond past the window: the reaper's to recover, not in flight.
      {
        ...base,
        createdAt: ago(30 * 60_000),
        id: 'op-stale',
        status: 'running',
        updatedAt: ago(DEFAULT_STALE_AFTER_MS + 1),
      },
      { ...base, id: 'op-done', status: 'done', updatedAt: ago(1000) },
      { ...base, id: 'op-waiting', status: 'waiting_for_human', updatedAt: ago(1000) },
    ]);

    const response = await request();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      failedTenants: [],
      operations: [
        {
          createdAt: ago(20 * 60_000).toISOString(),
          id: 'op-boundary',
          parentOperationId: null,
          status: 'running',
          stepCount: 4,
          tenantId: 't-a',
          trigger: 'chat',
          updatedAt: ago(DEFAULT_STALE_AFTER_MS).toISOString(),
        },
        {
          createdAt: ago(60_000).toISOString(),
          id: 'op-idle',
          parentOperationId: 'op-boundary',
          status: 'idle',
          stepCount: 0,
          tenantId: 't-a',
          trigger: null,
          updatedAt: ago(30_000).toISOString(),
        },
      ],
      tenants: { checked: 1, directory: 1, skipped: [] },
      windowSeconds: 300,
    });
  });

  it('reads every available tenant in its own scope and lists unadmitted tenants as skipped', async () => {
    mocks.listTenantAvailability.mockResolvedValue([
      { tenantId: 't-a' },
      { refusal: 'TENANT_FROZEN', tenantId: 't-frozen' },
      { tenantId: 't-b' },
      { refusal: 'TENANT_OFFLINE', tenantId: 't-offline' },
    ]);
    mocks.tenantDB.mockImplementation(async (tenantId?: string) => {
      if (tenantId === 't-a') return tenantADB;
      if (tenantId === 't-b')
        return fakeTenantDB([
          {
            createdAt: ago(90_000),
            id: 'op-b',
            parentOperationId: null,
            status: 'running',
            stepCount: 2,
            trigger: 'task',
            updatedAt: ago(10_000),
          },
        ]);
      throw new Error(`unexpected tenant ${tenantId}`);
    });

    const response = await request();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.enterTenantId.mock.calls.map(([id]) => id)).toEqual(['t-a', 't-b']);
    expect(body.operations).toEqual([expect.objectContaining({ id: 'op-b', tenantId: 't-b' })]);
    expect(body.tenants).toEqual({
      checked: 2,
      directory: 4,
      skipped: [
        { reason: 'TENANT_FROZEN', tenantId: 't-frozen' },
        { reason: 'TENANT_OFFLINE', tenantId: 't-offline' },
      ],
    });
    expect(body.failedTenants).toEqual([]);
  });

  it('answers 503 with the same body when any tenant read fails, without leaking the error', async () => {
    mocks.listTenantAvailability.mockResolvedValue([{ tenantId: 't-a' }, { tenantId: 't-b' }]);
    mocks.tenantDB.mockImplementation(async (tenantId?: string) => {
      if (tenantId === 't-a') return tenantADB;
      throw Object.assign(new Error('password authentication failed for titu_x_run'), {
        code: '28P01',
      });
    });
    await tenantADB.insert(agentOperations).values({
      id: 'op-a',
      status: 'running',
      updatedAt: ago(1000),
      userId: 'u1',
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = await request();
    const text = await response.text();
    const body = JSON.parse(text);

    expect(response.status).toBe(503);
    expect(body.failedTenants).toEqual([{ reason: '28P01', tenantId: 't-b' }]);
    expect(body.operations).toEqual([expect.objectContaining({ id: 'op-a', tenantId: 't-a' })]);
    expect(body.tenants).toEqual({ checked: 1, directory: 2, skipped: [] });
    expect(text).not.toContain('password');
    consoleError.mockRestore();
  });

  it('answers 503 when entering an available tenant is refused', async () => {
    mocks.listTenantAvailability.mockResolvedValue([{ tenantId: 't-a' }]);
    mocks.enterTenantId.mockRejectedValue(
      Object.assign(new Error('TENANT_UNAVAILABLE'), { code: 'TENANT_UNAVAILABLE' }),
    );
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = await request();

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      failedTenants: [{ reason: 'TENANT_UNAVAILABLE', tenantId: 't-a' }],
      operations: [],
      tenants: { checked: 0, directory: 1, skipped: [] },
    });
    consoleError.mockRestore();
  });
});

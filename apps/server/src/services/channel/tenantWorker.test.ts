// @vitest-environment node
import { currentTenantScope } from '@lobechat/database/tenant';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { LobeChatDatabase } from '@/database/type';

import { ChannelTenantWorker } from './tenantWorker';

const mocks = vi.hoisted(() => ({
  enterTenantId: vi.fn(),
  listAvailableTenantIds: vi.fn(),
}));

vi.mock('@/server/modules/Tenant/postgresClaims', () => ({
  heartbeatTenantProcess: vi.fn(),
  tenantClaims: { bind: () => async () => {}, enter: async () => async () => {} },
}));
vi.mock('@/server/modules/Tenant/runtime', () => ({ getTenantRuntime: () => mocks }));
// The global test setup replaces the gate with a pass-through; use the real one.
vi.mock('@/server/modules/Tenant/gate', async (importOriginal) => importOriginal());
// The real worker is covered by worker.test.ts / workerDispatch.test.ts.
vi.mock('./worker', () => ({ ChannelWorker: class {} }));

interface FakeWorker {
  close: ReturnType<typeof vi.fn>;
  tenantId: string;
  tick: ReturnType<typeof vi.fn>;
}

const db = {} as LobeChatDatabase;
const created: FakeWorker[] = [];
const ticked: (string | undefined)[] = [];
const closedIn: (string | undefined)[] = [];

const makeWorker = (tenantId: string) => {
  const worker: FakeWorker = {
    close: vi.fn(async () => {
      closedIn.push(currentTenantScope()?.tenantId);
    }),
    tenantId,
    tick: vi.fn(async () => {
      ticked.push(currentTenantScope()?.tenantId);
    }),
  };
  created.push(worker);
  return worker;
};

/** The coordinator creates a worker lazily, inside the tenant it belongs to. */
const coordinator = () =>
  new ChannelTenantWorker(db, () => makeWorker(currentTenantScope()?.tenantId ?? 'no-scope'));

const frozen = new Set<string>();
beforeEach(() => {
  vi.clearAllMocks();
  created.length = 0;
  ticked.length = 0;
  closedIn.length = 0;
  frozen.clear();
  mocks.listAvailableTenantIds.mockResolvedValue([]);
  mocks.enterTenantId.mockImplementation(async (tenantId: string) => {
    if (frozen.has(tenantId)) throw Object.assign(new Error('frozen'), { code: 'TENANT_FROZEN' });
    return { release: async () => {}, scope: { session: {}, slug: tenantId, tenantId } };
  });
});

describe('ChannelTenantWorker', () => {
  it('is an idle success with zero tenants', async () => {
    const worker = coordinator();
    await expect(worker.tick()).resolves.toEqual({ failed: [], ticked: [] });
    expect(created).toHaveLength(0);
    expect(mocks.enterTenantId).not.toHaveBeenCalled();
  });

  it('ticks every tenant inside its own scope with its own worker', async () => {
    mocks.listAvailableTenantIds.mockResolvedValue(['t-a', 't-b']);
    const worker = coordinator();
    const result = await worker.tick();
    expect(ticked).toEqual(['t-a', 't-b']);
    expect(created.map((entry) => entry.tenantId)).toEqual(['t-a', 't-b']);
    expect(result).toEqual({ failed: [], ticked: ['t-a', 't-b'] });
    expect(currentTenantScope()).toBeUndefined();
  });

  it('reuses a tenant worker across ticks so its in-memory run state survives', async () => {
    mocks.listAvailableTenantIds.mockResolvedValue(['t-a']);
    const worker = coordinator();
    await worker.tick();
    await worker.tick();
    expect(created).toHaveLength(1);
    expect(created[0].tick).toHaveBeenCalledTimes(2);
  });

  it('keeps processing other tenants when one throws, and reports it', async () => {
    mocks.listAvailableTenantIds.mockResolvedValue(['t-a', 't-b', 't-c']);
    const worker = coordinator();
    await worker.tick();
    created
      .find((entry) => entry.tenantId === 't-a')!
      .tick.mockRejectedValueOnce(new Error('boom'));
    ticked.length = 0;
    const result = await worker.tick();
    expect(ticked).toEqual(['t-b', 't-c']);
    expect(result.ticked).toEqual(['t-b', 't-c']);
    expect(result.failed).toEqual([{ reason: 'Error', tenantId: 't-a' }]);
  });

  it('skips a tenant whose admission is refused and still ticks the rest', async () => {
    mocks.listAvailableTenantIds.mockResolvedValue(['t-a', 't-b']);
    frozen.add('t-a');
    const worker = coordinator();
    const result = await worker.tick();
    expect(ticked).toEqual(['t-b']);
    expect(result.failed).toEqual([{ reason: 'TENANT_FROZEN', tenantId: 't-a' }]);
  });

  it('picks up a tenant provisioned later without a restart', async () => {
    mocks.listAvailableTenantIds.mockResolvedValue(['t-a']);
    const worker = coordinator();
    await worker.tick();
    mocks.listAvailableTenantIds.mockResolvedValue(['t-a', 't-new']);
    ticked.length = 0;
    await worker.tick();
    expect(ticked).toEqual(['t-a', 't-new']);
  });

  it('closes the worker of a tenant that is removed or frozen and stops ticking it', async () => {
    mocks.listAvailableTenantIds.mockResolvedValue(['t-a', 't-b']);
    const worker = coordinator();
    await worker.tick();
    mocks.listAvailableTenantIds.mockResolvedValue(['t-b']);
    ticked.length = 0;
    await worker.tick();
    expect(ticked).toEqual(['t-b']);
    const gone = created.find((entry) => entry.tenantId === 't-a')!;
    expect(gone.close).toHaveBeenCalledTimes(1);
    // Closing finalizes runs through the tenant database, so it happens inside the tenant.
    expect(closedIn).toEqual(['t-a']);
    expect(created.find((entry) => entry.tenantId === 't-b')!.close).not.toHaveBeenCalled();

    // Returning later starts from a fresh worker.
    mocks.listAvailableTenantIds.mockResolvedValue(['t-a', 't-b']);
    await worker.tick();
    expect(created.filter((entry) => entry.tenantId === 't-a')).toHaveLength(2);
  });

  it('still closes a removed tenant worker when the tenant can no longer be entered', async () => {
    mocks.listAvailableTenantIds.mockResolvedValue(['t-a']);
    const worker = coordinator();
    await worker.tick();
    frozen.add('t-a');
    mocks.listAvailableTenantIds.mockResolvedValue([]);
    await worker.tick();
    expect(created[0].close).toHaveBeenCalledTimes(1);
    expect(closedIn).toEqual([undefined]);
  });

  it('fails the tick when the tenant directory cannot be read', async () => {
    mocks.listAvailableTenantIds.mockRejectedValue(new Error('platform database down'));
    const worker = coordinator();
    await expect(worker.tick()).rejects.toThrow('platform database down');
  });

  it('closes every tenant worker on close and then refuses to start new ones', async () => {
    mocks.listAvailableTenantIds.mockResolvedValue(['t-a', 't-b']);
    const worker = coordinator();
    await worker.tick();
    created[0].close.mockRejectedValueOnce(new Error('drain failed'));
    await worker.close();
    expect(created.map((entry) => entry.close.mock.calls.length)).toEqual([2, 1]);
    expect(closedIn).toEqual(expect.arrayContaining(['t-b']));
    ticked.length = 0;
    await worker.tick();
    expect(ticked).toEqual([]);
  });
});

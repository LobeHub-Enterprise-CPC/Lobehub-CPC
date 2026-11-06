// @vitest-environment node
import { currentTenantScope, TENANT_POOL_CONNECTION_IDLE_MS } from '@lobechat/database/tenant';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

import type { LobeChatDatabase } from '@/database/type';

import { CHANNEL_TENANT_MAX_INTERVAL_MS, ChannelTenantWorker } from './tenantWorker';

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
  close: Mock<() => Promise<void>>;
  tenantId: string;
  tick: Mock<() => Promise<boolean>>;
}

const db = {} as LobeChatDatabase;
const created: FakeWorker[] = [];
const ticked: (string | undefined)[] = [];
const closedIn: (string | undefined)[] = [];
/** What a tenant's tick reports by default; finding work keeps the tenant due every round. */
let findsWork = true;
/** How long a tenant's tick takes (fake Date); its connection is returned when the tick ends. */
let tickMs = 0;

const makeWorker = (tenantId: string) => {
  const worker: FakeWorker = {
    close: vi.fn(async () => {
      closedIn.push(currentTenantScope()?.tenantId);
    }),
    tenantId,
    tick: vi.fn(async () => {
      ticked.push(currentTenantScope()?.tenantId);
      if (tickMs) vi.setSystemTime(Date.now() + tickMs);
      return findsWork;
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
  findsWork = true;
  tickMs = 0;
  frozen.clear();
  mocks.listAvailableTenantIds.mockResolvedValue([]);
  mocks.enterTenantId.mockImplementation(async (tenantId: string) => {
    if (frozen.has(tenantId)) throw Object.assign(new Error('frozen'), { code: 'TENANT_FROZEN' });
    return { release: async () => {}, scope: { session: {}, slug: tenantId, tenantId } };
  });
});

afterEach(() => {
  vi.useRealTimers();
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

describe('ChannelTenantWorker scheduling', () => {
  /** One coordinator round per simulated second, as scripts/channel-worker.ts loops. */
  const rounds = async (worker: ChannelTenantWorker, seconds: number) => {
    const at: number[] = [];
    for (let second = 0; second < seconds; second++) {
      vi.setSystemTime(second * 1000);
      ticked.length = 0;
      await worker.tick();
      if (ticked.length) at.push(second);
    }
    return at;
  };
  /** A tenant without Channel work: every tick comes back empty. */
  const idle = () => {
    findsWork = false;
    return coordinator();
  };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(0);
    mocks.listAvailableTenantIds.mockResolvedValue(['t-a']);
  });

  it('backs an idle tenant off to 120 s and does not enter it between due times', async () => {
    const worker = idle();
    // 1 s -> 2 s -> 4 s -> ... -> 64 s -> capped at 120 s.
    expect(await rounds(worker, 367)).toEqual([0, 2, 6, 14, 30, 62, 126, 246, 366]);
    // A skipped tenant takes no admission and no connection, and is still served, not retired.
    expect(mocks.enterTenantId).toHaveBeenCalledTimes(9);
    expect(created).toHaveLength(1);
    expect(created[0].close).not.toHaveBeenCalled();
  });

  it('measures an idle interval from when the round finished, so idle connections can be reclaimed', async () => {
    const worker = idle();
    // Empty queries take 1.2 s, and the script sleeps 1 s after each round.
    tickMs = 1200;
    const entries: { end: number; start: number }[] = [];
    let now = 0;
    for (let round = 0; round < 400; round++) {
      vi.setSystemTime(now);
      ticked.length = 0;
      const start = Date.now();
      await worker.tick();
      if (ticked.length) entries.push({ end: Date.now(), start });
      now = Date.now() + 1000;
    }
    const capped = entries.slice(-3);
    expect(capped).toHaveLength(3);
    // The next entry borrows a connection only after the pool's 30 s idle reclaim had its chance.
    for (let i = 1; i < capped.length; i++)
      expect(capped[i].start - capped[i - 1].end).toBeGreaterThanOrEqual(
        CHANNEL_TENANT_MAX_INTERVAL_MS,
      );
  });

  it('keeps an idle tenant away well past the tenant pool idle reclaim, so its connection stays closed', () => {
    // At the cap an idle tenant reopens a connection at most once per interval: with the interval
    // equal to the reclaim the connection is reopened right after it closes and never stays closed.
    expect(CHANNEL_TENANT_MAX_INTERVAL_MS).toBeGreaterThanOrEqual(
      4 * TENANT_POOL_CONNECTION_IDLE_MS,
    );
  });

  it('keeps a tenant with work due every round', async () => {
    const worker = coordinator();
    expect(await rounds(worker, 5)).toEqual([0, 1, 2, 3, 4]);
  });

  it('reports only the tenants it entered and serves a new tenant immediately', async () => {
    const worker = idle();
    await worker.tick();
    mocks.listAvailableTenantIds.mockResolvedValue(['t-a', 't-new']);
    vi.setSystemTime(1000);
    ticked.length = 0;
    await expect(worker.tick()).resolves.toEqual({ failed: [], ticked: ['t-new'] });
    expect(ticked).toEqual(['t-new']);
  });

  it('returns to 1 s as soon as an idle tenant finds work again', async () => {
    const worker = idle();
    await rounds(worker, 31);
    created[0].tick.mockResolvedValueOnce(true);
    vi.setSystemTime(61_000);
    ticked.length = 0;
    await worker.tick();
    expect(ticked).toEqual([]);
    vi.setSystemTime(62_000);
    await worker.tick();
    expect(created[0].tick).toHaveBeenCalledTimes(6);
    // Found work at 62 s: due again on the very next round.
    vi.setSystemTime(63_000);
    await worker.tick();
    expect(created[0].tick).toHaveBeenCalledTimes(7);
  });

  it('makes a woken idle tenant due on the next round', async () => {
    const worker = idle();
    await rounds(worker, 31);
    const calls = created[0].tick.mock.calls.length;
    vi.setSystemTime(31_000);
    await worker.tick();
    expect(created[0].tick).toHaveBeenCalledTimes(calls);

    worker.wake('t-a');
    vi.setSystemTime(32_000);
    await worker.tick();
    expect(created[0].tick).toHaveBeenCalledTimes(calls + 1);
    // The wake is consumed: an empty result keeps backing off.
    vi.setSystemTime(33_000);
    await worker.tick();
    expect(created[0].tick).toHaveBeenCalledTimes(calls + 1);
  });

  it('keeps a wake that arrives while the tenant is being ticked', async () => {
    const worker = idle();
    await rounds(worker, 31);
    const calls = created[0].tick.mock.calls.length;
    // A message committed after this tick's queries already ran.
    created[0].tick.mockImplementationOnce(async () => {
      worker.wake('t-a');
      return false;
    });
    vi.setSystemTime(62_000);
    await worker.tick();
    vi.setSystemTime(63_000);
    await worker.tick();
    expect(created[0].tick).toHaveBeenCalledTimes(calls + 2);
  });

  it('ignores a wake for a tenant it does not serve', async () => {
    const worker = idle();
    worker.wake('t-unknown');
    await worker.tick();
    expect(created.map((entry) => entry.tenantId)).toEqual(['t-a']);
  });

  it('keeps retrying a failing tenant every round', async () => {
    const worker = idle();
    await worker.tick();
    created[0].tick.mockRejectedValue(new Error('boom'));
    vi.setSystemTime(2000);
    await worker.tick();
    vi.setSystemTime(3000);
    await worker.tick();
    vi.setSystemTime(4000);
    await worker.tick();
    expect(created[0].tick).toHaveBeenCalledTimes(4);
  });
});

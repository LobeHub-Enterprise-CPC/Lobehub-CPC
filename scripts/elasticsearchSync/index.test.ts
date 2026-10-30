import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { FtsSearchSyncDrainResult } from '../../apps/server/src/services/ftsSearchSync';
import {
  currentTenantScope,
  runWithTenantScope,
  type TenantScope,
} from '../../packages/database/src/tenant/requestScope';
import {
  type FtsSearchSyncTenancy,
  runElasticsearchFtsSearchSync,
  runElasticsearchFtsSearchSyncCli,
} from './index';

const drainResult = (
  overrides: Partial<FtsSearchSyncDrainResult> = {},
): FtsSearchSyncDrainResult => ({
  acknowledged: 1,
  bulkBytes: 100,
  bulkItems: 1,
  bulkRequests: 1,
  bulkRequestSamples: [],
  claimed: 1,
  dead: 0,
  failed: 0,
  hasMore: false,
  released: 0,
  ...overrides,
});

const createRuntime = (results: FtsSearchSyncDrainResult[]) => {
  const drainOnce = vi.fn();
  for (const result of results) drainOnce.mockResolvedValueOnce(result);
  const runtime = {
    getFtsSearchSyncService: () => ({
      drainOnce,
      hasDeadLetters: vi.fn().mockResolvedValue(false),
    }),
    verifyFtsSearchSyncReadiness: vi.fn().mockResolvedValue(undefined),
  };
  return { drainOnce, runtime };
};

/**
 * Mirrors the tenant fan-out: every tenant runs in its own scope, one after another, and a failing
 * tenant is recorded without stopping the others.
 */
const createTenancy = (tenantIds: string[] = ['tenant-a']) => {
  const close = vi.fn(async () => undefined);
  const forEachTenant: FtsSearchSyncTenancy['forEachTenant'] = vi.fn(async (_job, operation) => {
    const result = { failed: [], succeeded: [] } as Awaited<
      ReturnType<FtsSearchSyncTenancy['forEachTenant']>
    >;
    for (const tenantId of tenantIds) {
      try {
        const value = await runWithTenantScope({ tenantId } as TenantScope, () =>
          operation(tenantId),
        );
        result.succeeded.push({ result: value, tenantId });
      } catch (error) {
        result.failed.push({ reason: (error as Error).name, tenantId });
      }
    }
    return result;
  });
  return { close, forEachTenant };
};

describe('runElasticsearchFtsSearchSync', () => {
  beforeEach(() => vi.clearAllMocks());

  it('drains until the queue is empty within the configured bound', async () => {
    const { drainOnce, runtime } = createRuntime([
      drainResult({ hasMore: true }),
      drainResult({ acknowledged: 2, bulkItems: 2, claimed: 2 }),
    ]);

    await expect(
      runElasticsearchFtsSearchSync({ loadRuntime: async () => runtime, maxSteps: 8 }),
    ).resolves.toMatchObject({ acknowledged: 3, claimed: 3, hasMore: false, steps: 2 });
    expect(runtime.verifyFtsSearchSyncReadiness).toHaveBeenCalledOnce();
    expect(drainOnce).toHaveBeenCalledTimes(2);
  });

  it('stops at the configured bound and reports remaining work', async () => {
    const { drainOnce, runtime } = createRuntime([drainResult({ hasMore: true })]);

    await expect(
      runElasticsearchFtsSearchSync({ loadRuntime: async () => runtime, maxSteps: 1 }),
    ).resolves.toMatchObject({ hasMore: true, steps: 1 });
    expect(drainOnce).toHaveBeenCalledOnce();
  });

  it('stops after the current step when the stop signal aborts mid-run', async () => {
    const controller = new AbortController();
    const { drainOnce, runtime } = createRuntime([]);
    drainOnce
      .mockImplementationOnce(async () => {
        controller.abort();
        return drainResult({ hasMore: true });
      })
      .mockResolvedValueOnce(drainResult({ hasMore: true }));

    await expect(
      runElasticsearchFtsSearchSync({
        loadRuntime: async () => runtime,
        maxSteps: 8,
        stopSignal: controller.signal,
      }),
    ).resolves.toMatchObject({ hasMore: true, steps: 1 });
    // The claimed work of the finished step is settled; no further step is started.
    expect(drainOnce).toHaveBeenCalledOnce();
  });

  it('fails before draining when durable dead letters already exist', async () => {
    const { runtime } = createRuntime([]);
    const service = runtime.getFtsSearchSyncService();
    service.hasDeadLetters = vi.fn().mockResolvedValue(true);
    runtime.getFtsSearchSyncService = () => service;

    await expect(
      runElasticsearchFtsSearchSync({ loadRuntime: async () => runtime, maxSteps: 1 }),
    ).rejects.toThrow('blocked by existing dead-letter work');
    expect(service.drainOnce).not.toHaveBeenCalled();
  });

  it('fails when dead-letter work appears concurrently after draining', async () => {
    const { runtime } = createRuntime([drainResult()]);
    const service = runtime.getFtsSearchSyncService();
    service.hasDeadLetters = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    runtime.getFtsSearchSyncService = () => service;

    await expect(
      runElasticsearchFtsSearchSync({ loadRuntime: async () => runtime, maxSteps: 1 }),
    ).rejects.toThrow('blocked by dead-letter work');
  });

  it.each([
    [drainResult({ dead: 1, failed: 1 }), 'created dead-letter work'],
    [drainResult({ failed: 1 }), 'left retryable failed work'],
  ])('fails on unsettled drain results', async (result, message) => {
    const { runtime } = createRuntime([result]);

    await expect(
      runElasticsearchFtsSearchSync({ loadRuntime: async () => runtime, maxSteps: 1 }),
    ).rejects.toThrow(message);
  });
});

describe('runElasticsearchFtsSearchSyncCli', () => {
  it('requires explicit acknowledgement before loading the runtime', async () => {
    const loadRuntime = vi.fn();
    const loadTenancy = vi.fn();
    const logError = vi.fn();

    await expect(
      runElasticsearchFtsSearchSyncCli({ args: [], loadRuntime, loadTenancy, logError }),
    ).resolves.toBe(1);
    expect(loadRuntime).not.toHaveBeenCalled();
    expect(loadTenancy).not.toHaveBeenCalled();
    expect(logError).toHaveBeenCalledWith(
      'Elasticsearch full-text search sync failed:',
      'Elasticsearch full-text search sync requires --yes after reviewing its documented effects',
    );
  });

  it('returns zero and emits only bounded numeric summaries after a successful drain', async () => {
    const { runtime } = createRuntime([
      drainResult({
        bulkRequestSamples: [
          {
            bytes: 100,
            durationMs: 10,
            entities: { messages: { bytes: 100, items: 1, result: 'success' } },
            items: 1,
            messageTombstoneItems: 1,
            result: 'success',
          },
        ],
      }),
    ]);
    const logSuccess = vi.fn();

    await expect(
      runElasticsearchFtsSearchSyncCli({
        args: ['--yes'],
        loadRuntime: async () => runtime,
        loadTenancy: async () => createTenancy(),
        logSuccess,
      }),
    ).resolves.toBe(0);
    expect(logSuccess).toHaveBeenLastCalledWith(
      expect.stringContaining('"type":"fts_search_sync_completed"'),
    );
    expect(logSuccess).toHaveBeenLastCalledWith(
      expect.stringContaining('"messageTombstoneItems":1'),
    );
  });

  it('keeps draining in interval mode until the stop signal aborts', async () => {
    const { drainOnce, runtime } = createRuntime([
      drainResult({ hasMore: true }),
      drainResult(),
      drainResult(),
    ]);
    const controller = new AbortController();
    const sleep = vi.fn(async (_milliseconds: number, signal: AbortSignal) => {
      expect(signal).toBe(controller.signal);
      if (sleep.mock.calls.length === 2) controller.abort();
    });
    const logSuccess = vi.fn();

    await expect(
      runElasticsearchFtsSearchSyncCli({
        args: ['--interval-seconds=15', '--max-steps=1', '--yes'],
        loadRuntime: async () => runtime,
        loadTenancy: async () => createTenancy(),
        logSuccess,
        sleep,
        stopSignal: controller.signal,
      }),
    ).resolves.toBe(0);

    // Run 1 reports hasMore, so the worker continues immediately; runs 2 and 3 sleep.
    expect(drainOnce).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(15_000, controller.signal);
    expect(logSuccess).toHaveBeenLastCalledWith(
      JSON.stringify({ type: 'fts_search_sync_interval_stopped' }),
    );
  });

  it('exits non-zero from interval mode when a bounded run fails', async () => {
    const { runtime } = createRuntime([drainResult({ dead: 1, failed: 1 })]);
    const sleep = vi.fn();
    const logError = vi.fn();

    await expect(
      runElasticsearchFtsSearchSyncCli({
        args: ['--interval-seconds=15', '--yes'],
        loadRuntime: async () => runtime,
        loadTenancy: async () => createTenancy(),
        logError,
        sleep,
        stopSignal: new AbortController().signal,
      }),
    ).resolves.toBe(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(logError).toHaveBeenCalledWith(
      'Elasticsearch full-text search sync failed for tenant %s:',
      'tenant-a',
      'Elasticsearch full-text search sync created dead-letter work',
    );
  });

  it('drains every available tenant inside that tenant scope', async () => {
    const scopes: (string | undefined)[] = [];
    const drainOnce = vi.fn(async () => {
      scopes.push(currentTenantScope()?.tenantId);
      return drainResult();
    });
    const runtime = {
      getFtsSearchSyncService: () => ({ drainOnce, hasDeadLetters: async () => false }),
      verifyFtsSearchSyncReadiness: vi.fn(async () => {
        // Readiness resolves the tenant's own index namespace and database.
        if (!currentTenantScope()) throw new Error('no tenant scope');
      }),
    };
    const tenancy = createTenancy(['tenant-a', 'tenant-b']);
    const logSuccess = vi.fn();

    await expect(
      runElasticsearchFtsSearchSyncCli({
        args: ['--yes'],
        loadRuntime: async () => runtime,
        loadTenancy: async () => tenancy,
        logSuccess,
      }),
    ).resolves.toBe(0);

    expect(scopes).toEqual(['tenant-a', 'tenant-b']);
    expect(runtime.verifyFtsSearchSyncReadiness).toHaveBeenCalledTimes(2);
    expect(logSuccess).toHaveBeenCalledWith(expect.stringContaining('"tenantId":"tenant-b"'));
    // The process leaves tenant admission once the run is over.
    expect(tenancy.close).toHaveBeenCalledOnce();
  });

  it('keeps draining the other tenants when one fails, then exits non-zero naming it', async () => {
    const drainOnce = vi.fn(async () =>
      currentTenantScope()?.tenantId === 'tenant-a' ? drainResult({ failed: 1 }) : drainResult(),
    );
    const runtime = {
      getFtsSearchSyncService: () => ({ drainOnce, hasDeadLetters: async () => false }),
      verifyFtsSearchSyncReadiness: async () => undefined,
    };
    const tenancy = createTenancy(['tenant-a', 'tenant-b']);
    const logError = vi.fn();

    await expect(
      runElasticsearchFtsSearchSyncCli({
        args: ['--yes'],
        loadRuntime: async () => runtime,
        loadTenancy: async () => tenancy,
        logError,
        logSuccess: vi.fn(),
      }),
    ).resolves.toBe(1);

    expect(drainOnce).toHaveBeenCalledTimes(2);
    expect(logError).toHaveBeenCalledWith(
      'Elasticsearch full-text search sync failed for tenant %s:',
      'tenant-a',
      'Elasticsearch full-text search sync left retryable failed work',
    );
    expect(logError).toHaveBeenLastCalledWith(
      'Elasticsearch full-text search sync failed:',
      'Elasticsearch full-text search sync failed for 1 tenant(s): tenant-a',
    );
    expect(tenancy.close).toHaveBeenCalledOnce();
  });

  it('keeps going without sleeping while any tenant still has more work', async () => {
    const controller = new AbortController();
    const drainOnce = vi.fn(async () =>
      drainResult({
        hasMore: currentTenantScope()?.tenantId === 'tenant-b' && drainOnce.mock.calls.length <= 2,
      }),
    );
    const runtime = {
      getFtsSearchSyncService: () => ({ drainOnce, hasDeadLetters: async () => false }),
      verifyFtsSearchSyncReadiness: async () => undefined,
    };
    const sleep = vi.fn(async () => controller.abort());

    await expect(
      runElasticsearchFtsSearchSyncCli({
        args: ['--interval-seconds=15', '--max-steps=1', '--yes'],
        loadRuntime: async () => runtime,
        loadTenancy: async () => createTenancy(['tenant-a', 'tenant-b']),
        logSuccess: vi.fn(),
        sleep,
        stopSignal: controller.signal,
      }),
    ).resolves.toBe(0);

    // Round 1 leaves work for tenant-b, so round 2 starts at once; round 2 is drained and sleeps.
    expect(drainOnce).toHaveBeenCalledTimes(4);
    expect(sleep).toHaveBeenCalledOnce();
  });
});

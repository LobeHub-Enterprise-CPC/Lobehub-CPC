import type { FtsSearchSyncDrainResult } from '../../apps/server/src/services/ftsSearchSync';
import { summarizeFtsSearchReindexError } from '../elasticsearchReindex/runtime/auditLogger';
import { parseElasticsearchFtsSearchSyncCliOptions } from './options';

type FtsSearchSyncService = {
  drainOnce: () => Promise<FtsSearchSyncDrainResult>;
  hasDeadLetters: () => Promise<boolean>;
};

type FtsSearchSyncRuntime = {
  getFtsSearchSyncService: () => FtsSearchSyncService;
  verifyFtsSearchSyncReadiness: () => Promise<unknown>;
};

/**
 * The deployment's tenants as the sync worker sees them. The application runtime resolves the
 * index namespace and the business database from the current tenant scope, so every drain has to
 * run inside one admitted tenant.
 */
export interface FtsSearchSyncTenancy {
  /** Leaves tenant admission (process lease) once the worker is done. */
  close: () => Promise<void>;
  /** Runs `operation` once per available tenant, in that tenant's own scope; see `forEachTenant`. */
  forEachTenant: <T>(
    job: string,
    operation: (tenantId: string) => Promise<T>,
  ) => Promise<{
    failed: { reason: string; tenantId: string }[];
    succeeded: { result: T; tenantId: string }[];
  }>;
}

export interface ElasticsearchFtsSearchSyncRunSummary {
  acknowledged: number;
  bulkBytes: number;
  bulkItems: number;
  bulkRequests: number;
  claimed: number;
  failed: number;
  hasMore: boolean;
  messageTombstoneItems: number;
  released: number;
  steps: number;
}

export interface RunElasticsearchFtsSearchSyncOptions {
  loadRuntime?: () => Promise<FtsSearchSyncRuntime>;
  logStep?: (summary: ElasticsearchFtsSearchSyncRunSummary) => void;
  maxSteps: number;
  /**
   * When aborted, the run stops after the current drain step instead of using the whole bound,
   * so a supervisor stop only has to wait for one step rather than `maxSteps` of them.
   */
  stopSignal?: AbortSignal;
}

const loadRuntime = () => import('../../apps/server/src/services/ftsSearchSync');

/**
 * The same tenant fan-out the deployment-wide crons use: tenants from the platform directory
 * (`DATABASE_URL`) that are currently admitted, each entered through its runtime role with this
 * process holding a tenant process lease, so lifecycle changes (freeze, offline, destruction)
 * fence the worker like any other tenant work.
 */
const loadTenancy = async (): Promise<FtsSearchSyncTenancy> => {
  const [{ forEachTenant }, { tenantProcessLease }] = await Promise.all([
    import('../../apps/server/src/modules/Tenant/fanOut'),
    import('../../apps/server/src/modules/Tenant/postgresClaims'),
  ]);
  return { close: () => tenantProcessLease.stop(), forEachTenant };
};

/** Runs a bounded drain so any cron or process supervisor can schedule it without a daemon. */
export const runElasticsearchFtsSearchSync = async ({
  loadRuntime: load = loadRuntime,
  logStep = () => undefined,
  maxSteps,
  stopSignal,
}: RunElasticsearchFtsSearchSyncOptions): Promise<ElasticsearchFtsSearchSyncRunSummary> => {
  const runtime = await load();
  await runtime.verifyFtsSearchSyncReadiness();
  const service = runtime.getFtsSearchSyncService();
  if (await service.hasDeadLetters()) {
    throw new Error('Elasticsearch full-text search sync is blocked by existing dead-letter work');
  }

  const summary: ElasticsearchFtsSearchSyncRunSummary = {
    acknowledged: 0,
    bulkBytes: 0,
    bulkItems: 0,
    bulkRequests: 0,
    claimed: 0,
    failed: 0,
    hasMore: false,
    messageTombstoneItems: 0,
    released: 0,
    steps: 0,
  };

  for (let step = 0; step < maxSteps; step += 1) {
    const drained = await service.drainOnce();
    summary.acknowledged += drained.acknowledged;
    summary.bulkBytes += drained.bulkBytes;
    summary.bulkItems += drained.bulkItems;
    summary.bulkRequests += drained.bulkRequests;
    summary.claimed += drained.claimed;
    summary.failed += drained.failed;
    summary.hasMore = drained.hasMore;
    summary.messageTombstoneItems += drained.bulkRequestSamples.reduce(
      (total, sample) => total + (sample.messageTombstoneItems ?? 0),
      0,
    );
    summary.released += drained.released;
    summary.steps += 1;
    logStep({ ...summary });

    if (drained.dead > 0) {
      throw new Error('Elasticsearch full-text search sync created dead-letter work');
    }
    if (drained.failed > 0) {
      throw new Error('Elasticsearch full-text search sync left retryable failed work');
    }
    if (drained.claimed === 0 || !drained.hasMore) break;
    if (stopSignal?.aborted) break;
  }

  if (await service.hasDeadLetters()) {
    throw new Error('Elasticsearch full-text search sync is blocked by dead-letter work');
  }

  return summary;
};

type Logger = (...arguments_: unknown[]) => void;

export interface RunElasticsearchFtsSearchSyncCliOptions {
  args?: readonly string[];
  loadRuntime?: () => Promise<FtsSearchSyncRuntime>;
  loadTenancy?: () => Promise<FtsSearchSyncTenancy>;
  logError?: Logger;
  logSuccess?: Logger;
  /** Injectable sleep for the long-running interval mode. */
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  /** Aborting this signal stops interval mode after the current bounded run finishes. */
  stopSignal?: AbortSignal;
}

const defaultSleep = (milliseconds: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });

/**
 * SIGINT / SIGTERM stop interval mode gracefully so a container supervisor can stop the worker
 * between bounded runs without abandoning claimed Outbox work mid-run.
 */
const createProcessStopSignal = () => {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  return controller.signal;
};

export const runElasticsearchFtsSearchSyncCli = async ({
  args = process.argv.slice(2),
  loadRuntime: load,
  loadTenancy: openTenancy = loadTenancy,
  logError = console.error,
  logSuccess = console.log,
  sleep = defaultSleep,
  stopSignal,
}: RunElasticsearchFtsSearchSyncCliOptions = {}): Promise<number> => {
  let tenancy: FtsSearchSyncTenancy | undefined;
  try {
    const options = parseElasticsearchFtsSearchSyncCliOptions(args);
    if (!options.yes) {
      throw new Error(
        'Elasticsearch full-text search sync requires --yes after reviewing its documented effects',
      );
    }
    tenancy = await openTenancy();
    const tenants = tenancy;

    /**
     * One round drains every available tenant with the bounded semantics, one tenant at a time.
     * A failing tenant is logged and does not stop the others; the round fails afterwards,
     * naming the failed tenants. Returns whether any tenant still has more work.
     */
    const runOnce = async (signal?: AbortSignal) => {
      const { failed, succeeded } = await tenants.forEachTenant(
        'fts-search:sync',
        async (tenantId) => {
          try {
            return await runElasticsearchFtsSearchSync({
              loadRuntime: load,
              logStep: (step) =>
                logSuccess(JSON.stringify({ ...step, tenantId, type: 'fts_search_sync_step' })),
              maxSteps: options.maxSteps,
              stopSignal: signal,
            });
          } catch (error) {
            logError(
              'Elasticsearch full-text search sync failed for tenant %s:',
              tenantId,
              summarizeFtsSearchReindexError(error),
            );
            throw error;
          }
        },
      );
      for (const { result, tenantId } of succeeded) {
        logSuccess(
          JSON.stringify({ ...result, success: true, tenantId, type: 'fts_search_sync_completed' }),
        );
      }
      if (failed.length > 0) {
        throw new Error(
          `Elasticsearch full-text search sync failed for ${failed.length} tenant(s): ${failed
            .map(({ tenantId }) => tenantId)
            .join(', ')}`,
        );
      }
      return succeeded.some(({ result }) => result.hasMore);
    };

    if (options.intervalSeconds === undefined) {
      await runOnce();
      return 0;
    }

    /**
     * Interval mode is the Compose-friendly long-running form of the same bounded drain. Each
     * iteration keeps the bounded semantics; a drain that leaves failed or dead work still exits
     * non-zero so the supervisor restart policy and logs make the failure visible. A stop signal
     * ends the run after the current step, so the supervisor's grace period only has to cover one
     * step, never a whole bounded run.
     */
    const signal = stopSignal ?? createProcessStopSignal();
    logSuccess(
      JSON.stringify({
        intervalSeconds: options.intervalSeconds,
        maxSteps: options.maxSteps,
        type: 'fts_search_sync_interval_started',
      }),
    );
    while (!signal.aborted) {
      const hasMore = await runOnce(signal);
      if (signal.aborted) break;
      if (!hasMore) await sleep(options.intervalSeconds * 1000, signal);
    }
    logSuccess(JSON.stringify({ type: 'fts_search_sync_interval_stopped' }));
    return 0;
  } catch (error) {
    logError('Elasticsearch full-text search sync failed:', summarizeFtsSearchReindexError(error));
    return 1;
  } finally {
    await tenancy?.close().catch((error) => {
      logError(
        'Elasticsearch full-text search sync could not leave tenant admission:',
        summarizeFtsSearchReindexError(error),
      );
    });
  }
};

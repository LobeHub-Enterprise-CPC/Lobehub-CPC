import debug from 'debug';

import type { LobeChatDatabase } from '@/database/type';
import { forEachTenant } from '@/server/modules/Tenant/fanOut';
import { runInTenant } from '@/server/modules/Tenant/gate';

import { ChannelWorker } from './worker';

const log = debug('lobe-server:channel:tenant-worker');

/** What the coordinator needs from a per-tenant worker (see {@link ChannelWorker}). */
interface TenantChannelWorker {
  close: () => Promise<void>;
  tick: () => Promise<void>;
}

export interface ChannelTenantTickResult {
  /** Tenants whose tick failed or could not be entered; the others were still processed. */
  failed: { reason: string; tenantId: string }[];
  ticked: string[];
}

/**
 * Channel queue consumer for a multi-tenant deployment (spec FR-AS-02).
 *
 * Channel runs, jobs and messages live in each tenant's schema, and there is no
 * process-wide business database: the plain {@link ChannelWorker} fails closed
 * outside a tenant scope. This coordinator is the deployment-wide job that
 * enters every available tenant in turn (`forEachTenant`, the same fan-out the
 * crons and the bot gateway use) and runs that tenant's own worker inside its
 * scope.
 *
 * - One {@link ChannelWorker} per tenant, created on first sight: its in-memory
 *   state (active native runs, finalizers, job cursor, probe backoff) is keyed by
 *   ids that only mean something inside one tenant schema.
 * - Tenants are listed again on every tick, so a newly provisioned tenant is
 *   served on the next tick; a tenant that is no longer available (frozen,
 *   offline, expired, removed) is skipped and its worker is closed and dropped.
 * - A tenant that throws, or cannot be entered, does not stop the others.
 * - `tick` rejects only when the tenant directory cannot be read, which is what
 *   an unhealthy coordinator means. Zero tenants is a healthy idle state.
 */
export class ChannelTenantWorker {
  private closed = false;
  private readonly workers = new Map<string, TenantChannelWorker>();
  /** Last failure reported per tenant, so a persistent fault is logged once, not every tick. */
  private readonly lastFailure = new Map<string, string>();

  constructor(
    private readonly db: LobeChatDatabase,
    private readonly createWorker: (db: LobeChatDatabase) => TenantChannelWorker = (database) =>
      new ChannelWorker(database),
  ) {}

  async tick(): Promise<ChannelTenantTickResult> {
    if (this.closed) return { failed: [], ticked: [] };
    const result = await forEachTenant('channel:worker', async (tenantId) => {
      if (this.closed) return;
      let worker = this.workers.get(tenantId);
      if (!worker) {
        worker = this.createWorker(this.db);
        this.workers.set(tenantId, worker);
      }
      await worker.tick();
    });

    const failed = result.failed;
    const seen = new Set([...result.succeeded, ...failed].map(({ tenantId }) => tenantId));
    for (const tenantId of this.lastFailure.keys())
      if (!failed.some((entry) => entry.tenantId === tenantId)) this.lastFailure.delete(tenantId);
    for (const { reason, tenantId } of failed) {
      if (this.lastFailure.get(tenantId) === reason) continue;
      this.lastFailure.set(tenantId, reason);
      console.error(`[channel-worker] tenant ${tenantId} skipped: ${reason}`);
    }

    const gone = [...this.workers.keys()].filter((tenantId) => !seen.has(tenantId));
    await Promise.all(gone.map((tenantId) => this.retire(tenantId)));
    return { failed, ticked: result.succeeded.map(({ tenantId }) => tenantId) };
  }

  /** Aborts every tenant's active runs and drains them; no further tenant is entered. */
  async close() {
    this.closed = true;
    await Promise.all([...this.workers.keys()].map((tenantId) => this.retire(tenantId)));
  }

  /**
   * Draining finalizes runs through the tenant database, so it happens inside the
   * tenant while it can still be entered. A tenant that was taken away cannot be
   * entered: its runs are still aborted, and whatever could not be finalized is
   * found by the next worker as a run whose executor disappeared (execution unknown).
   */
  private async retire(tenantId: string) {
    const worker = this.workers.get(tenantId);
    if (!worker) return;
    this.workers.delete(tenantId);
    this.lastFailure.delete(tenantId);
    try {
      await runInTenant(tenantId, () => worker.close());
    } catch (error) {
      log('closing tenant %s outside its scope: %O', tenantId, error);
      await worker
        .close()
        .catch((cause) => console.error(`[channel-worker] tenant ${tenantId} drain failed`, cause));
    }
  }
}

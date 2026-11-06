import debug from 'debug';

import type { LobeChatDatabase } from '@/database/type';
import { forEachTenant } from '@/server/modules/Tenant/fanOut';
import { runInTenant } from '@/server/modules/Tenant/gate';

import { ChannelWorker } from './worker';

const log = debug('lobe-server:channel:tenant-worker');

/** A tenant whose last tick found Channel work is entered on every coordinator round (1 s). */
export const CHANNEL_TENANT_MIN_INTERVAL_MS = 1000;
/**
 * Consecutive empty ticks double a tenant's interval up to this bound. It is a fallback for a
 * lost wake: new work is announced by a wake. It stays well above the tenant pool's connection
 * idle reclaim (30 s), so an idle tenant's connection is closed for most of the interval instead
 * of being reopened right after it closes.
 */
export const CHANNEL_TENANT_MAX_INTERVAL_MS = 120_000;

/** What the coordinator needs from a per-tenant worker (see {@link ChannelWorker}). */
interface TenantChannelWorker {
  close: () => Promise<void>;
  /** Resolves true when the tenant has Channel work, so it stays due every round. */
  tick: () => Promise<boolean>;
}

interface TenantSchedule {
  /** When an idle tenant is entered again. */
  due: number;
  /** Consecutive ticks that found no work; 0 keeps the tenant due every round. */
  idleTicks: number;
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
 * - Each tenant has its own due time, so idle tenants hold no connection: a tenant
 *   whose tick found work (or that failed) is entered every round; consecutive
 *   empty ticks back it off 2 s, 4 s, ... up to {@link CHANNEL_TENANT_MAX_INTERVAL_MS}.
 *   The Web side publishes a wake once it commits new Channel work ({@link wake}),
 *   which makes the tenant due on the next round; the bounded interval covers a
 *   lost or absent signal (no Redis).
 */
export class ChannelTenantWorker {
  private closed = false;
  private readonly workers = new Map<string, TenantChannelWorker>();
  /** Last failure reported per tenant, so a persistent fault is logged once, not every tick. */
  private readonly lastFailure = new Map<string, string>();
  private readonly schedule = new Map<string, TenantSchedule>();
  /** Tenants woken since their last tick started; kept across a tick so a wake is never lost. */
  private readonly woken = new Set<string>();

  constructor(
    private readonly db: LobeChatDatabase,
    private readonly createWorker: (db: LobeChatDatabase) => TenantChannelWorker = (database) =>
      new ChannelWorker(database),
  ) {}

  /** New Channel work was committed for this tenant: enter it on the next round. */
  wake(tenantId: string) {
    // A tenant without a worker yet is new, and new tenants are entered right away.
    if (this.workers.has(tenantId)) this.woken.add(tenantId);
  }

  async tick(): Promise<ChannelTenantTickResult> {
    if (this.closed) return { failed: [], ticked: [] };
    const round = Date.now();
    const result = await forEachTenant(
      'channel:worker',
      async (tenantId) => {
        if (this.closed) return true;
        let worker = this.workers.get(tenantId);
        if (!worker) {
          worker = this.createWorker(this.db);
          this.workers.set(tenantId, worker);
        }
        this.woken.delete(tenantId);
        return worker.tick();
      },
      { skip: (tenantId) => !this.isDue(tenantId, round) },
    );

    const failed = result.failed;
    // Intervals start when the round has finished, after every tenant scope released its
    // connections: an idle tenant is entered again only once those connections have sat idle
    // for the whole interval, so the tenant pool's idle reclaim can close them.
    const finished = Date.now();
    for (const { result: busy, tenantId } of result.succeeded)
      this.reschedule(tenantId, busy, finished);
    // A failure is retried every round, as before scheduling existed.
    for (const { tenantId } of failed) this.reschedule(tenantId, true, finished);
    const seen = new Set([
      ...result.skipped,
      ...[...result.succeeded, ...failed].map(({ tenantId }) => tenantId),
    ]);
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

  private isDue(tenantId: string, now: number) {
    const entry = this.schedule.get(tenantId);
    return !entry || entry.idleTicks === 0 || entry.due <= now || this.woken.has(tenantId);
  }

  private reschedule(tenantId: string, busy: boolean, finished: number) {
    if (!this.workers.has(tenantId)) return;
    const idleTicks = busy ? 0 : (this.schedule.get(tenantId)?.idleTicks ?? 0) + 1;
    const interval = Math.min(
      CHANNEL_TENANT_MIN_INTERVAL_MS * 2 ** idleTicks,
      CHANNEL_TENANT_MAX_INTERVAL_MS,
    );
    this.schedule.set(tenantId, { due: finished + interval, idleTicks });
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
    this.schedule.delete(tenantId);
    this.woken.delete(tenantId);
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

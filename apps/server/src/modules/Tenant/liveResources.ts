import debug from 'debug';

import type { TenantClaims } from './claims';
import { TenantGateError, tenantGateErrorOf } from './errors';
import { heartbeatTenantProcess, tenantClaims } from './postgresClaims';
import { getTenantRuntime } from './runtime';

const log = debug('lobe-server:tenant-live');

/** How often a process re-checks a tenant that has live resources here. */
export const TENANT_WATCH_INTERVAL_MS = 5000;

/**
 * Longest a watcher waits for the platform database. A check that does not
 * answer in time counts as a refusal: the tenant's resources are closed.
 */
export const TENANT_WATCH_CHECK_TIMEOUT_MS = 2000;

/** Longest one resource may take to close or reopen before the attempt counts as failed. */
export const TENANT_RESOURCE_ACTION_TIMEOUT_MS = 10_000;

export interface TenantLiveResource {
  /** Stops the resource. Must be safe to call again after a failed or timed-out attempt. */
  close: (reason: TenantGateError) => unknown;
  /** Restarts the resource when the tenant is admitted again; without it the resource is dropped once closed. */
  reopen?: () => unknown;
  /** Completion of the work itself; emitting cancellation alone never settles it. */
  settled?: Promise<void>;
}

/** Some resources of a tenant could not be closed or reopened; they stay registered for a retry. */
export class TenantLiveResourceError extends AggregateError {
  constructor(
    readonly action: 'close' | 'reopen',
    readonly tenantId: string,
    errors: unknown[],
  ) {
    super(errors, `TENANT_LIVE_RESOURCE_${action.toUpperCase()}_FAILED: ${errors.length}`);
    this.name = 'TenantLiveResourceError';
  }
}

interface TenantEntry {
  /** Bumped by every local suspend / resume: a watcher result read before it is stale. */
  generation: number;
  /** Serializes suspend, resume and watcher results for the tenant. */
  queue: Promise<unknown>;
  resources: Map<TenantLiveResource, 'closed' | 'open'>;
  suspended?: TenantGateError;
  timer?: ReturnType<typeof setInterval>;
  watching: boolean;
}

const withTimeout = async <T>(run: () => T | Promise<T>, ms: number, label: string) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(run),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

/**
 * Long-lived work a tenant holds in this process (spec FR-CP-06 stages 2–3,
 * FR-AS-03): response streams, bot connections and running agent steps.
 * Transactions re-check admission themselves; these keep running without
 * asking again, so they are registered here and stopped when the tenant
 * stops being admitted.
 *
 * The process that executes a lifecycle event calls {@link suspend} /
 * {@link resume}. A resource that fails to close or reopen stays registered,
 * the call rejects (the event fails and Console retries it), and the next
 * call retries only what is left. Every other process learns the event by
 * watching: while a tenant has resources here it is re-checked every
 * `intervalMs`, and a refusal, an error or a check slower than
 * `checkTimeoutMs` closes them;
 * the durable claim stays present until the actual work settles. A stalled
 * or unreachable process therefore prevents lifecycle completion.
 */
export class TenantLiveResources {
  private readonly tenants = new Map<string, TenantEntry>();
  private readonly completions = new WeakMap<TenantLiveResource, () => Promise<void>>();
  private readonly closing = new WeakMap<TenantLiveResource, Promise<void>>();

  constructor(
    private readonly check: (tenantId: string) => Promise<void>,
    private readonly intervalMs = TENANT_WATCH_INTERVAL_MS,
    private readonly checkTimeoutMs = TENANT_WATCH_CHECK_TIMEOUT_MS,
    private readonly actionTimeoutMs = TENANT_RESOURCE_ACTION_TIMEOUT_MS,
    private readonly claims?: TenantClaims,
  ) {}

  /**
   * Registers a resource; the returned function unregisters it once it ends by
   * itself. A resource bound while the tenant is suspended here is closed at once.
   */
  bind(tenantId: string, resource: TenantLiveResource): () => void {
    const complete = this.claims?.bind(tenantId);
    if (complete) this.completions.set(resource, complete);
    const entry = this.entry(tenantId);
    entry.resources.set(resource, 'open');
    this.watch(tenantId, entry);
    if (entry.suspended) {
      const reason = entry.suspended;
      this.enqueue(entry, () => this.closeOpen(tenantId, entry, reason)).catch((error) =>
        log('closing a resource bound while %s is suspended failed: %O', tenantId, error),
      );
    }
    return () => {
      this.complete(resource);
      entry.resources.delete(resource);
      this.prune(tenantId, entry);
    };
  }

  /** Closes every open resource of the tenant here; rejects if any could not be closed. */
  suspend(tenantId: string, reason: TenantGateError): Promise<void> {
    const entry = this.tenants.get(tenantId);
    if (!entry) return Promise.resolve();
    entry.generation += 1;
    return this.enqueue(entry, () => this.closeOpen(tenantId, entry, reason));
  }

  /** Reopens the tenant's closed resources here; rejects if any could not be reopened. */
  resume(tenantId: string): Promise<void> {
    const entry = this.tenants.get(tenantId);
    if (!entry) return Promise.resolve();
    entry.generation += 1;
    return this.enqueue(entry, () => this.reopenClosed(tenantId, entry));
  }

  /** Resources of the tenant registered here, open or closed awaiting reopen. */
  size(tenantId: string) {
    return this.tenants.get(tenantId)?.resources.size ?? 0;
  }

  private complete(resource: TenantLiveResource) {
    const done = this.completions.get(resource);
    if (!done) return;
    this.completions.delete(resource);
    void done().catch((error) => log('claim release failed, durable claim retained: %O', error));
  }

  private entry(tenantId: string) {
    let entry = this.tenants.get(tenantId);
    if (!entry) {
      entry = { generation: 0, queue: Promise.resolve(), resources: new Map(), watching: false };
      this.tenants.set(tenantId, entry);
    }
    return entry;
  }

  private enqueue(entry: TenantEntry, run: () => Promise<void>): Promise<void> {
    const next = entry.queue.then(run, run);
    entry.queue = next.catch(() => undefined);
    return next;
  }

  private async closeOpen(tenantId: string, entry: TenantEntry, reason: TenantGateError) {
    entry.suspended = reason;
    // Signal every resource before waiting: a parent may need its child to
    // receive cancellation before the parent itself can finish.
    const outcomes = await Promise.allSettled(
      [...entry.resources]
        .filter(([, state]) => state === 'open')
        .map(async ([resource]) => {
          let stopping = this.closing.get(resource);
          if (!stopping) {
            stopping = Promise.resolve().then(async () => {
              await resource.close(reason);
              await resource.settled;
              if (!entry.resources.has(resource)) return;
              this.complete(resource);
              if (resource.reopen) entry.resources.set(resource, 'closed');
              else entry.resources.delete(resource);
              this.prune(tenantId, entry);
            });
            this.closing.set(resource, stopping);
            const clear = () => {
              if (this.closing.get(resource) === stopping) this.closing.delete(resource);
            };
            // Timeout does not end the action. Keep the same promise until the
            // underlying action settles; a retry must not launch a second stop.
            void stopping.then(clear, clear);
          }
          await withTimeout(() => stopping!, this.actionTimeoutMs, 'close');
        }),
    );
    const errors = outcomes.flatMap((outcome) =>
      outcome.status === 'rejected' ? [outcome.reason] : [],
    );
    log('suspended tenant %s (%s): %d failed', tenantId, reason.code, errors.length);
    this.prune(tenantId, entry);
    if (errors.length > 0) throw new TenantLiveResourceError('close', tenantId, errors);
  }

  private async reopenClosed(tenantId: string, entry: TenantEntry) {
    // A timed-out stop can still be running. Finish it before restarting the
    // same resource, otherwise its late completion could stop the replacement.
    if (entry.suspended && [...entry.resources.values()].includes('open')) {
      await this.closeOpen(tenantId, entry, entry.suspended);
    }
    entry.suspended = undefined;
    const errors: unknown[] = [];
    for (const [resource, state] of entry.resources) {
      if (state !== 'closed') continue;
      try {
        if (this.claims && !this.completions.has(resource))
          this.completions.set(resource, await this.claims.enter(tenantId));
        await withTimeout(() => resource.reopen?.(), this.actionTimeoutMs, 'reopen');
        if (entry.resources.has(resource)) entry.resources.set(resource, 'open');
      } catch (error) {
        errors.push(error);
      }
    }
    log('resumed tenant %s: %d failed', tenantId, errors.length);
    if (errors.length > 0) throw new TenantLiveResourceError('reopen', tenantId, errors);
  }

  private watch(tenantId: string, entry: TenantEntry) {
    if (entry.timer) return;
    entry.timer = setInterval(() => void this.poll(tenantId, entry), this.intervalMs);
    // Watching never keeps the process alive on its own.
    (entry.timer as { unref?: () => void }).unref?.();
  }

  private prune(tenantId: string, entry: TenantEntry) {
    if (entry.resources.size > 0) return;
    if (entry.timer) clearInterval(entry.timer);
    entry.timer = undefined;
    if (this.tenants.get(tenantId) === entry) this.tenants.delete(tenantId);
  }

  private async poll(tenantId: string, entry: TenantEntry) {
    // The check is bounded, so this flag cannot stay set past one timeout.
    if (entry.watching) return;
    entry.watching = true;
    const generation = entry.generation;
    let refusal: TenantGateError | undefined;
    try {
      await withTimeout(() => this.check(tenantId), this.checkTimeoutMs, 'tenant check');
    } catch (error) {
      refusal =
        tenantGateErrorOf(error) ??
        new TenantGateError('TENANT_UNAVAILABLE', undefined, { cause: error });
    } finally {
      entry.watching = false;
    }

    try {
      await this.enqueue(entry, async () => {
        // A local suspend / resume since the check started is newer: keep it.
        if (entry.generation !== generation) return;
        if (refusal) await this.closeOpen(tenantId, entry, refusal);
        else if (entry.suspended || [...entry.resources.values()].includes('closed'))
          await this.reopenClosed(tenantId, entry);
      });
    } catch (error) {
      // Still registered; the next tick retries.
      log('watcher action for tenant %s failed: %O', tenantId, error);
    }
  }
}

let live: TenantLiveResources | null = null;

/** The process-wide registry; watchers read the platform database fresh. */
export const getTenantLiveResources = (): TenantLiveResources => {
  live ??= new TenantLiveResources(
    async (tenantId) => {
      await heartbeatTenantProcess();
      await getTenantRuntime().assertAdmitted(tenantId, 0);
    },
    undefined,
    undefined,
    undefined,
    tenantClaims,
  );
  return live;
};

/**
 * Ties a response body to its tenant: when the tenant is suspended the
 * response fails at once (the client sees a broken stream and reconnects into
 * the gate's refusal) and the source is cancelled, which stops its
 * subscriptions and upstream requests.
 *
 * The body stays registered until the source has ended or its cancel has
 * completed. The source is cancelled only once, so a failed cancel is kept:
 * every later close (a retried suspension) fails with it instead of treating
 * the stream as closed while its upstream may still run.
 */
export const guardTenantStream = (
  registry: TenantLiveResources,
  tenantId: string,
  source: ReadableStream<Uint8Array>,
  abort?: (reason: unknown) => void,
): ReadableStream<Uint8Array> => {
  const reader = source.getReader();
  let release = () => {};
  /** The response side is closed or errored; nothing more is enqueued. */
  let settled = false;
  let cancelled: Promise<void> | undefined;
  const cancelSource = (reason: unknown) => {
    if (!cancelled) {
      abort?.(reason);
      cancelled = reader.cancel(reason).then(() => release());
      // Observed by whoever awaits it; never an unhandled rejection here.
      cancelled.catch(() => undefined);
    }
    return cancelled;
  };

  return new ReadableStream<Uint8Array>({
    cancel(reason) {
      settled = true;
      return cancelSource(reason);
    },
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (settled) return;
        if (done) {
          settled = true;
          release();
          controller.close();
        } else controller.enqueue(value);
      } catch (error) {
        if (settled) return;
        // The source failed by itself: nothing upstream is left running.
        settled = true;
        release();
        controller.error(error);
      }
    },
    start(controller) {
      release = registry.bind(tenantId, {
        close: (reason) => {
          if (!settled) {
            settled = true;
            controller.error(reason);
          }
          return cancelSource(reason);
        },
      });
    },
  });
};

import type { DestructionRecord, DrainResult } from '@/server/modules/Tenant/destruction';

import {
  ControlPlaneError,
  type DestructionPhase,
  type DestructionRequest,
  type DestructionResult,
  type DestructionStatus,
  type DestructionStatusResult,
} from './contracts';
import type { ControlPlaneRepository, ControlPlaneTx, UnregisterItem } from './repository';

/**
 * The three phases of destroying one tenant UUID (contracts/tenant-control-plane/tenant-destruction.json):
 * `barrier` establishes the durable terminal, `drain` waits for work that was already running (or
 * revokes its right to write), `unregister` removes the platform catalog entries and writes
 * `completedAt` with the last deletion. Each phase is repeatable and decided from the terminal alone,
 * never from whether directory rows still exist.
 *
 * The fencing itself is not in this class. Every other control-plane transaction reads the terminal
 * under the tenant control lock the barrier holds (`ControlPlaneRepository.transaction`), and the
 * writers outside that lock take the destruction fence (`modules/Tenant/destruction.ts`). `drain`
 * therefore never has to stop anything: it observes what was running, waits for it, and revokes the
 * execution leases of what remains, which is what turns `drained` into `fenced`.
 */

export interface TenantDestructionOptions {
  /** Clock of the drain's wait budget; a test replaces it together with `sleep`. */
  clock?: () => number;
  /** Longest one drain request waits before it answers 202 `applying`. */
  drainBudgetMs?: number;
  drainPollMs?: number;
  now?: () => Date;
  repository: ControlPlaneRepository;
  /** Retires this process's connection pools of the tenant; true when a live route was held. */
  retirePool?: (tenantId: string) => boolean;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_DRAIN_BUDGET_MS = 10_000;
const DEFAULT_DRAIN_POLL_MS = 250;

/** What the phase answered when it was first complete: later phases never leak into an earlier answer. */
const respond = (
  phase: DestructionPhase,
  record: DestructionRecord,
  status: DestructionStatus,
  items?: UnregisterItem[],
): DestructionResult => ({
  completedAt: phase === 'unregister' ? record.completedAt : null,
  destroyOperationId: record.destroyOperationId,
  drainResult: phase === 'barrier' || status === 'applying' ? null : record.drainResult,
  ...(items && { items }),
  phase,
  status,
  tenantId: record.tenantId,
  terminalEstablishedAt: record.terminalEstablishedAt,
});

type DrainStep = { done: DestructionRecord; kind: 'done' } | { kind: 'pending' } | { kind: 'wait' };

export class TenantDestructionService {
  private readonly clock: () => number;
  private readonly drainBudgetMs: number;
  private readonly drainPollMs: number;
  private readonly now: () => Date;
  private readonly repository: ControlPlaneRepository;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: TenantDestructionOptions) {
    this.clock = options.clock ?? Date.now;
    this.drainBudgetMs = options.drainBudgetMs ?? DEFAULT_DRAIN_BUDGET_MS;
    this.drainPollMs = options.drainPollMs ?? DEFAULT_DRAIN_POLL_MS;
    this.now = options.now ?? (() => new Date());
    this.repository = options.repository;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** A failure inside a phase is transient and the phase is resumable: Console retries it. */
  private async phase<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof ControlPlaneError) throw error;
      console.error(
        JSON.stringify({ event: 'tenant_destruction_failed', name: (error as Error)?.name }),
      );
      throw new ControlPlaneError(503, 'TENANT_DESTRUCTION_FAILED');
    }
  }

  async apply(request: DestructionRequest): Promise<DestructionResult> {
    return this.phase(() => {
      switch (request.phase) {
        case 'barrier': {
          return this.barrier(request);
        }
        case 'drain': {
          return this.drain(request);
        }
        case 'unregister': {
          return this.unregister(request);
        }
      }
    });
  }

  /** The status query: never writes, never establishes a terminal, never waits. */
  async status(tenantId: string, destroyOperationId?: string): Promise<DestructionStatusResult> {
    const record = await this.phase(() => this.repository.readDestruction(tenantId));
    if (!record)
      return {
        completedAt: null,
        destroyOperationId: null,
        drainResult: null,
        reached: null,
        tenantId,
        terminalEstablishedAt: null,
      };
    if (destroyOperationId && record.destroyOperationId !== destroyOperationId)
      throw new ControlPlaneError(409, 'OPERATION_CONFLICT');
    return {
      completedAt: record.completedAt,
      destroyOperationId: record.destroyOperationId,
      drainResult: record.drainResult,
      reached: record.completedAt ? 'unregister' : record.drainResult ? 'drain' : 'barrier',
      tenantId,
      terminalEstablishedAt: record.terminalEstablishedAt,
    };
  }

  /** The recorded terminal, which must belong to this destruction. */
  private async terminalOf(
    tx: ControlPlaneTx,
    { destroyOperationId, tenantId }: DestructionRequest,
  ) {
    const record = await tx.getDestruction(tenantId);
    if (!record) throw new ControlPlaneError(409, 'DESTROY_PHASE_ORDER');
    if (record.destroyOperationId !== destroyOperationId)
      throw new ControlPlaneError(409, 'OPERATION_CONFLICT');
    return record;
  }

  /**
   * Creates the terminal, even for a tenant this application has never heard of: a late provision of
   * that UUID must find the terminal, not an empty catalog. Nothing is deleted.
   */
  private barrier(request: DestructionRequest) {
    const { destroyOperationId, tenantId } = request;
    return this.repository.transaction(
      tenantId,
      async (tx) => {
        const existing =
          (await tx.getDestruction(tenantId)) ??
          (await tx.createDestruction(tenantId, destroyOperationId, this.now().toISOString()));
        if (existing.destroyOperationId !== destroyOperationId)
          throw new ControlPlaneError(409, 'OPERATION_CONFLICT');
        return respond('barrier', existing, 'applied');
      },
      { destruction: true },
    );
  }

  /**
   * Waits for the operations that were running when the barrier was established. Runtime processes
   * must have dropped the tenant and released every request pinned for it; the wait is bounded and
   * answers 202 so Console repeats the same request. Control-plane executions and external work are
   * never waited out: they cannot write any more, and whatever is left of them has its execution
   * lease revoked, which is the `fenced` result.
   */
  private async drain(request: DestructionRequest): Promise<DestructionResult> {
    const { tenantId } = request;
    const deadline = this.clock() + this.drainBudgetMs;
    for (;;) {
      const step = await this.repository.transaction(
        tenantId,
        async (tx): Promise<DrainStep> => {
          const record = await this.terminalOf(tx, request);
          if (record.drainResult) return { done: record, kind: 'done' };
          const seen = await tx.observeDrain(tenantId, this.now());
          const idle = !seen.processes && seen.liveOperations === 0;
          if (!idle && this.clock() < deadline) return { kind: 'wait' };
          if (seen.processes) return { kind: 'pending' };
          let result: DrainResult = 'drained';
          if (seen.liveOperations > 0 || seen.externalWork) {
            await tx.fenceInFlight(tenantId);
            result = 'fenced';
          }
          return { done: await tx.finishDrain(tenantId, result), kind: 'done' };
        },
        { destruction: true },
      );
      if (step.kind === 'done') return respond('drain', step.done, 'applied');
      if (step.kind === 'pending') {
        const record = await this.repository.readDestruction(tenantId);
        if (!record) throw new ControlPlaneError(409, 'DESTROY_PHASE_ORDER');
        return respond('drain', record, 'applying');
      }
      await this.sleep(this.drainPollMs);
    }
  }

  /**
   * Removes the catalog entries in one transaction that also writes `completedAt`: a crash leaves
   * `completedAt` null and the same request continues. A completed unregister is only ever replayed.
   */
  private unregister(request: DestructionRequest) {
    const { tenantId } = request;
    return this.repository.transaction(
      tenantId,
      async (tx) => {
        const record = await this.terminalOf(tx, request);
        if (!record.drainResult) throw new ControlPlaneError(409, 'DESTROY_PHASE_ORDER');
        if (record.completedAt) return respond('unregister', record, 'absent');
        const pool = this.options.retirePool?.(tenantId) ? 'deleted' : 'absent';
        const completedAt = this.now().toISOString();
        const items = await tx.unregisterTenant(tenantId, completedAt, pool);
        return respond('unregister', { ...record, completedAt }, 'applied', items);
      },
      { destruction: true },
    );
  }
}

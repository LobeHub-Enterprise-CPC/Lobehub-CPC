import debug from 'debug';

import { AgentOperationModel } from '@/database/models/agentOperation';
import type { LobeChatDatabase } from '@/database/type';

import { AbandonOperationService } from './AbandonOperationService';
import type { AbandonedSubAgentResume, FinalizeAbandonedResult } from './AbandonOperationService';

const log = debug('lobe-server:sub-agent-deadline');

/**
 * How long a freshly spawned sub-operation may stay without ever claiming its
 * first step before this module retires it.
 *
 * A `callSubAgent` child starts its run with a single fire-and-forget queue
 * delivery (`createOperation` → `scheduleMessage`). When that delivery never
 * executes — the creating process is draining, the gateway version check
 * refuses the step, the tenant is deferred, the local queue's `setTimeout`
 * chain is lost with the process — the child row stays `running` with no step,
 * no LLM call and no error, while its parent sits parked on the `callSubAgent`
 * tool call. Nothing in the child's own lifecycle notices: the stale-operation
 * sweep only redrives runs it can resume, and the gateway's inactivity watchdog
 * does not act until 30 minutes have passed. Observed in production
 * (2026-10-26, tenant citic-tel): child created 06:52:41, zero steps, abandoned
 * at 07:22:42 with an empty `error` column, parent dead ten minutes earlier.
 *
 * A healthy child claims step 0 within milliseconds of being created (the queue
 * delay is 50ms), and a step that IS running refreshes its durable lease while
 * it holds the step lock (`startStepLockHeartbeat`: lock refresh every 30s,
 * durable `updated_at` touch every 90s). Three minutes therefore leaves a full
 * extra heartbeat of slack over the slowest legitimate first step, while still
 * ending a lost dispatch ~27 minutes before the watchdog would.
 */
export const DEFAULT_FIRST_STEP_DEADLINE_MS = 3 * 60_000;

/** Floor for any configured deadline, so a typo cannot kill healthy runs. */
export const MIN_FIRST_STEP_DEADLINE_MS = 5_000;

/**
 * Slack on the creation write: `started_at` and the row's first `updated_at`
 * land a few milliseconds apart, and a row stays "untouched" until the step
 * lock starts heartbeating (the first durable touch lands at 90s).
 */
export const CLAIM_SETTLE_MS = 5_000;

/** Optional deployment override for {@link DEFAULT_FIRST_STEP_DEADLINE_MS}. */
export const FIRST_STEP_DEADLINE_ENV = 'SUBAGENT_FIRST_STEP_DEADLINE_MS';

/**
 * The child was created but never claimed a step: its first-step delivery was
 * lost. Nothing ran, so ending it loses no work.
 */
export const FIRST_STEP_NEVER_STARTED = 'subagent_first_step_never_started';

/** The caller's explicit `callSubAgent.timeout` elapsed while the child was live. */
export const SUB_AGENT_TIMEOUT = 'subagent_timeout';

export const resolveFirstStepDeadlineMs = (override?: number): number => {
  const requested =
    typeof override === 'number' && Number.isFinite(override) && override > 0
      ? override
      : Number(process.env[FIRST_STEP_DEADLINE_ENV]);

  if (!Number.isFinite(requested) || requested <= 0) return DEFAULT_FIRST_STEP_DEADLINE_MS;

  return Math.max(MIN_FIRST_STEP_DEADLINE_MS, Math.floor(requested));
};

/**
 * Whether a live child has demonstrably never claimed its first step.
 *
 * `step_count` alone is not enough: it counts COMPLETED steps, so a step 0 that
 * is legitimately in flight still reads 0. The durable lease is what separates
 * the two — a step holding the step lock touches `updatedAt` every
 * `STEP_LOCK_HEARTBEAT_MS * DURABLE_LEASE_HEARTBEAT_EVERY_TICKS` (90s), while a
 * row whose delivery was dropped keeps the timestamp of its creation write and
 * nothing else. Recorded LLM/tool calls
 * are honoured too, so any child that got work done is never treated as stalled
 * even if its lease reads stale.
 *
 * Unknown timestamps are treated as "alive": this guard only ever acts on a
 * positive signal, because abandoning a run is irreversible.
 */
export const neverClaimedStep = (
  operation: {
    llmCalls?: number | null;
    startedAt?: Date | string | null;
    stepCount?: number | null;
    toolCalls?: number | null;
    updatedAt?: Date | string | null;
  },
  fallbackStartedAtMs: number,
): boolean => {
  if ((operation.stepCount ?? 0) > 0) return false;
  if ((operation.llmCalls ?? 0) > 0 || (operation.toolCalls ?? 0) > 0) return false;
  if (!operation.updatedAt) return false;

  const startedAtMs = operation.startedAt
    ? new Date(operation.startedAt).getTime()
    : fallbackStartedAtMs;
  if (!Number.isFinite(startedAtMs)) return false;

  const lastWriteMs = new Date(operation.updatedAt).getTime();
  if (!Number.isFinite(lastWriteMs)) return false;

  return lastWriteMs <= startedAtMs + CLAIM_SETTLE_MS;
};

/**
 * Which deadline (if any) a live child has overrun.
 *
 * Split out from the DB read so the policy is testable on its own: a child that
 * never claimed a step is judged by the first-step deadline, a child that is
 * making progress only by the caller's explicit timeout.
 */
export const subAgentDeadlineViolation = (params: {
  elapsedMs: number;
  firstStepDeadlineMs: number;
  /** Derived by {@link neverClaimedStep} from the durable row. */
  neverClaimed: boolean;
  timeoutMs?: number;
}): string | null => {
  const { elapsedMs, firstStepDeadlineMs, neverClaimed, timeoutMs } = params;

  // Prefer the diagnostic reason when both deadlines are past.
  if (neverClaimed && elapsedMs >= firstStepDeadlineMs) return FIRST_STEP_NEVER_STARTED;
  if (timeoutMs && timeoutMs > 0 && elapsedMs >= timeoutMs) return SUB_AGENT_TIMEOUT;

  return null;
};

export interface SubAgentDeadlineDeps {
  agentOperationModel: Pick<AgentOperationModel, 'findById'>;
  /** `AbandonOperationService.finalizeAbandoned`, injected so this stays testable. */
  abandon: (operationId: string, reason: string) => Promise<FinalizeAbandonedResult>;
  /**
   * Hands a `subAgentResume` from the abandon path to the bridge that resumes
   * the parked parent. Without it the child would die with the parent still
   * parked on its tool call.
   */
  resumeParent?: (operationId: string, resume: AbandonedSubAgentResume) => Promise<void>;
}

export type SubAgentDeadlineOutcome = 'abandoned' | 'alive' | 'skipped';

export interface SubAgentDeadlineCheckParams {
  firstStepDeadlineMs?: number;
  operationId: string;
  /** Creation time of the child run; both deadlines are measured from it. */
  spawnedAt: number;
  /** The caller's explicit `callSubAgent.timeout`, if any. */
  timeoutMs?: number;
}

/**
 * Retire a child that has overrun its deadline, or report that it is fine.
 *
 * `skipped` covers everything this must not touch: a missing row, a row another
 * path already settled (`done` / `error` / `abandoned`), and a row that is
 * parked (`waiting_for_human` / `waiting_for_async_tool` / `waiting_for_client`)
 * — a parked run is not stalled, it is waiting for something that will resume
 * it.
 */
export const checkSubAgentDeadline = async (
  deps: SubAgentDeadlineDeps,
  params: SubAgentDeadlineCheckParams,
): Promise<SubAgentDeadlineOutcome> => {
  const { operationId, spawnedAt, timeoutMs } = params;
  const firstStepDeadlineMs = resolveFirstStepDeadlineMs(params.firstStepDeadlineMs);

  const operation = await deps.agentOperationModel.findById(operationId).catch((error) => {
    log('[%s] operation lookup failed, treating as untouchable: %O', operationId, error);
    return null;
  });

  if (!operation) return 'skipped';
  // Only a live, unparked run is ours to judge. A terminal row belongs to the
  // normal completion path, and a `waiting_for_*` row is deliberately parked on
  // something that resumes it (an approval, a client LLM call, a sibling tool).
  if (operation.status !== 'running') return 'skipped';

  const elapsedMs = Date.now() - spawnedAt;
  const reason = subAgentDeadlineViolation({
    elapsedMs,
    firstStepDeadlineMs,
    neverClaimed: neverClaimedStep(operation, spawnedAt),
    timeoutMs,
  });

  if (!reason) return 'alive';

  log(
    '[%s] sub-agent overran its deadline (%s) after %dms with %s steps — ending it',
    operationId,
    reason,
    elapsedMs,
    operation.stepCount ?? 0,
  );

  const result = await deps.abandon(operationId, reason);

  if (result.subAgentResume && deps.resumeParent) {
    try {
      await deps.resumeParent(operationId, result.subAgentResume);
    } catch (error) {
      // The parent resume carries its own durability (`resumeAbandonedParent`
      // re-queues the bridge in queue mode); a failure here must not turn a
      // completed abandonment into an unhandled rejection.
      log('[%s] failed to resume the parent after the deadline: %O', operationId, error);
    }
  }

  return 'abandoned';
};

export type ArmSubAgentDeadlineParams = SubAgentDeadlineCheckParams;

/**
 * Arm the bounded deadline for one spawned child and return a canceller.
 *
 * The first check fires at the earliest of the two deadlines. When the child is
 * healthy at that point AND the caller gave an explicit timeout, exactly one
 * more check is armed for the remaining time — the common case (no explicit
 * timeout) arms a single timer and never touches the child again.
 *
 * Timers are unref'd: a deadline must never keep a process (or a test run)
 * alive on its own.
 */
export const armSubAgentDeadline = (
  deps: SubAgentDeadlineDeps,
  params: ArmSubAgentDeadlineParams,
): (() => void) => {
  const firstStepDeadlineMs = resolveFirstStepDeadlineMs(params.firstStepDeadlineMs);
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const schedule = (delayMs: number) => {
    if (cancelled) return;
    timer = setTimeout(
      () => {
        void tick();
      },
      Math.max(1, delayMs),
    );
    (timer as unknown as { unref?: () => void }).unref?.();
  };

  const tick = async () => {
    if (cancelled) return;

    const outcome = await checkSubAgentDeadline(deps, {
      firstStepDeadlineMs,
      operationId: params.operationId,
      spawnedAt: params.spawnedAt,
      timeoutMs: params.timeoutMs,
    }).catch((error) => {
      log('[%s] deadline check failed: %O', params.operationId, error);
      return 'skipped' as SubAgentDeadlineOutcome;
    });

    if (cancelled || outcome !== 'alive') return;

    // The child is running. Only an explicit timeout can still end it, and it
    // has not elapsed at the first check — re-arm for what is left of it.
    if (!params.timeoutMs || params.timeoutMs <= 0) return;

    const remainingMs = params.timeoutMs - (Date.now() - params.spawnedAt);
    if (remainingMs > 0) schedule(remainingMs);
  };

  schedule(
    params.timeoutMs && params.timeoutMs > 0
      ? Math.min(firstStepDeadlineMs, params.timeoutMs)
      : firstStepDeadlineMs,
  );

  return () => {
    cancelled = true;
    if (timer) clearTimeout(timer);
  };
};

export interface SubAgentDeadlineArmerOptions {
  db: LobeChatDatabase;
  userId: string;
  workspaceId?: string;
}

export type SubAgentDeadlineArmer = (params: {
  operationId: string;
  spawnedAt: number;
  timeoutMs?: number;
}) => void;

/**
 * Production wiring for {@link armSubAgentDeadline}: retires the stalled child
 * through the same abandon path the gateway watchdog uses, then resumes its
 * parked parent.
 *
 * `resumeAbandonedParent` is imported lazily because it constructs
 * `AiAgentService`, which is what arms this deadline in the first place — a
 * static import would make the two modules circular.
 */
export const createSubAgentDeadlineArmer =
  ({ db, userId, workspaceId }: SubAgentDeadlineArmerOptions): SubAgentDeadlineArmer =>
  (params) => {
    armSubAgentDeadline(
      {
        abandon: (operationId, reason) =>
          new AbandonOperationService(db).finalizeAbandoned(operationId, reason),
        agentOperationModel: new AgentOperationModel(db, userId, workspaceId),
        resumeParent: async (operationId, resume) => {
          const { resumeAbandonedParent } = await import('./resumeAbandonedParent');
          await resumeAbandonedParent(db, operationId, resume);
        },
      },
      params,
    );
  };

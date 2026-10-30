import debug from 'debug';

import { AgentOperationModel } from '@/database/models/agentOperation';
import { type LobeChatDatabase } from '@/database/type';

import {
  type AbandonedSubAgentResume,
  AbandonOperationService,
  type FinalizeAbandonedResult,
} from './AbandonOperationService';
import {
  neverClaimedStep,
  resolveFirstStepDeadlineMs,
  subAgentDeadlineViolation,
} from './firstStepPolicy';

const log = debug('lobe-server:sub-agent-deadline');

export interface SubAgentDeadlineDeps {
  /** `AbandonOperationService.finalizeAbandoned`, injected so this stays testable. */
  abandon: (operationId: string, reason: string) => Promise<FinalizeAbandonedResult>;
  agentOperationModel: Pick<AgentOperationModel, 'findById'>;
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
 * This is the FAST path: it fires in the process that created the child, so it
 * cannot cover the case this module exists for most — that process dying. The
 * durable counterpart is the first-step pass in `StaleOperationReaper`, which
 * reaches the same verdict from the persisted row.
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

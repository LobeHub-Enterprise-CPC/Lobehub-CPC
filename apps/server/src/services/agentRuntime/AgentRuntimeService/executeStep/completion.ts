import type { AgentState } from '@lobechat/agent-runtime';
import type { Span } from '@lobechat/observability-otel/api';
import { buildInvokeAgentResultAttributes } from '@lobechat/observability-otel/modules/agent-runtime';
import debug from 'debug';

import { isHatchetDeliveryEnabled } from '@/server/modules/Hatchet/config';

import { logToolCallPc } from '../../formalObservation';
import { steerQueueScopeOf } from '../../steerQueueScope';
import { type AgentExecutionResult } from '../../types';
import { determineCompletionReason } from '../stepPolicy';
import type { AgentRuntimeServiceContext } from '../types';
import type { StepRunResult } from './runStep';

const log = debug('lobe-server:agent-runtime-service');

/** What this module reads off the service. */
export type StepCompletionDeps = Pick<
  AgentRuntimeServiceContext,
  | 'completionLifecycle'
  | 'coordinator'
  | 'delegate'
  | 'determineCompletionReason'
  | 'recordInterventionLifecycleCompletion'
  | 'traceRecorder'
  | 'tryResumeParentFromAsyncTool'
  | 'userId'
>;

/**
 * Hatchet only: whether a terminal run still owes its completion lifecycle
 * (durable row, onComplete/onError). Saved with the terminal state, settled
 * once the hooks are out, so a redelivery can tell "finished, not announced"
 * from a finished run.
 */
export const COMPLETION_LIFECYCLE_CHECKPOINT_KEY = '_completionLifecycle';

export interface CompletionLifecycleCheckpoint {
  reason: string;
  state: 'completed' | 'pending';
  stepIndex: number;
}

const COMPLETION_TERMINAL_STATUSES = new Set<AgentState['status']>([
  'done',
  'error',
  'interrupted',
]);

const readCompletionCheckpoint = (state: AgentState) =>
  state.metadata?.[COMPLETION_LIFECYCLE_CHECKPOINT_KEY] as
    CompletionLifecycleCheckpoint | undefined;

/**
 * A terminal run whose completion lifecycle is still owed. No checkpoint means
 * nothing is owed: a state written before the checkpoint existed (or outside
 * Hatchet) is never announced a second time.
 */
export const owesCompletionLifecycle = (state: AgentState | null | undefined): boolean =>
  isHatchetDeliveryEnabled() &&
  !!state &&
  COMPLETION_TERMINAL_STATUSES.has(state.status) &&
  readCompletionCheckpoint(state)?.state === 'pending' &&
  readCompletionCheckpoint(state)?.reason === determineCompletionReason(state);

/**
 * Mark a terminal state's lifecycle as owed before it is saved, so the marker
 * lands in the same write as the terminal status: a crash anywhere after that
 * write leaves a redelivery something to replay.
 */
export const markCompletionLifecyclePending = (state: AgentState, stepIndex: number): void => {
  if (!isHatchetDeliveryEnabled() || !COMPLETION_TERMINAL_STATUSES.has(state.status)) return;
  state.metadata = {
    ...state.metadata,
    [COMPLETION_LIFECYCLE_CHECKPOINT_KEY]: {
      reason: determineCompletionReason(state),
      state: 'pending',
      stepIndex,
    } satisfies CompletionLifecycleCheckpoint,
  };
};

/**
 * The hooks are out. A failed checkpoint write must retry the delivery;
 * critical webhooks carry a stable deduplication id for that replay.
 */
export async function recordCompletionLifecycleCompleted(
  deps: Pick<AgentRuntimeServiceContext, 'coordinator'>,
  operationId: string,
  state: AgentState,
  assertOwnership?: () => Promise<void>,
): Promise<void> {
  const checkpoint = readCompletionCheckpoint(state);
  if (!isHatchetDeliveryEnabled() || checkpoint?.state !== 'pending') return;

  state.metadata = {
    ...state.metadata,
    [COMPLETION_LIFECYCLE_CHECKPOINT_KEY]: {
      ...checkpoint,
      state: 'completed',
    } satisfies CompletionLifecycleCheckpoint,
  };
  await deps.coordinator.saveAgentState(operationId, state, assertOwnership);
}

/**
 * The run stops here: emit the completion signals, dispatch the completion
 * hooks, record a parked intervention, re-check a just-parked async-tool
 * barrier, finalize the trace and start the follow-ups queued behind it.
 */
export async function finishOperation(
  deps: StepCompletionDeps,
  {
    assertOwnership,
    invokeAgentSpan,
    operationId,
    stepIndex,
    stepResult,
  }: {
    assertOwnership?: () => Promise<void>;
    invokeAgentSpan: Span;
    operationId: string;
    stepIndex: number;
    stepResult: StepRunResult;
  },
): Promise<void> {
  const reason = deps.determineCompletionReason(stepResult.newState);
  invokeAgentSpan.setAttributes(buildInvokeAgentResultAttributes({ completionReason: reason }));

  // A client park is no completion: the run continues under this id.
  const completionSignalEvents =
    reason === 'waiting_for_client'
      ? []
      : await deps.completionLifecycle.emitSignalEvents(operationId, stepResult.newState, reason);
  logToolCallPc(operationId, stepIndex, 'post.completion_signals', () => ({ reason }));

  // Dispatch completion hooks
  if (isHatchetDeliveryEnabled() && COMPLETION_TERMINAL_STATUSES.has(stepResult.newState.status)) {
    await deps.completionLifecycle.dispatchHooks(operationId, stepResult.newState, reason, {
      assertOwnership,
      strict: true,
    });
  } else {
    await deps.completionLifecycle.dispatchHooks(operationId, stepResult.newState, reason, {
      assertOwnership,
    });
  }
  logToolCallPc(operationId, stepIndex, 'post.completion_hooks', () => ({ reason }));
  if (owesCompletionLifecycle(stepResult.newState)) {
    await assertOwnership?.();
    await recordCompletionLifecycleCompleted(
      deps,
      operationId,
      stepResult.newState,
      assertOwnership,
    );
  }

  if (reason === 'waiting_for_human') {
    await assertOwnership?.();
    await deps.recordInterventionLifecycleCompletion(
      operationId,
      stepResult.newState,
      stepIndex,
      assertOwnership,
    );
  }

  // Finalize tracing snapshot. The error catch below uses the same
  // recorder so propagated failures still write the canonical S3
  // snapshot instead of orphaning the partial ().
  // Async/human waits expose a readable canonical snapshot and retain the partial.
  // Write it before the self-check can hand this id to another invocation.
  await assertOwnership?.();
  const newStateError = stepResult.newState.error;
  if (reason === 'waiting_for_client') {
    await deps.traceRecorder.flushPartial();
  } else
    await deps.traceRecorder.finalize(operationId, {
      appendEventsToLastStep: completionSignalEvents,
      assertOwnership,
      completionReason: reason,
      error: newStateError
        ? {
            attribution: newStateError.attribution,
            body: newStateError.body,
            category: newStateError.category,
            countAsFailure: newStateError.countAsFailure,
            httpStatus: newStateError.httpStatus,
            message:
              deps.completionLifecycle.extractErrorMessage(newStateError) ??
              JSON.stringify(newStateError),
            numericId: newStateError.numericId,
            retryable: newStateError.retryable,
            severity: newStateError.severity,
            type: String(newStateError.type ?? newStateError.errorType ?? 'unknown'),
          }
        : undefined,
      state: stepResult.newState,
    });
  logToolCallPc(operationId, stepIndex, 'post.trace_finalized', () => ({ reason }));

  // Park-time self-check: sub-agents are dispatched mid-step, so a
  // fast child can complete BEFORE this op's parked state/row were
  // persisted — its resume attempt then no-ops against the status
  // guard and nothing retries. Now that both the Redis state and the
  // `agent_operations` row (via dispatchHooks → persistCompletion)
  // say `waiting_for_async_tool`, re-run the barrier once to recover
  // any resume that raced the park.
  if (stepResult.newState.status === 'waiting_for_async_tool') {
    // The readable snapshot and resumable partial are already durable. Never
    // write either after this barrier can hand execution to another invocation.
    await assertOwnership?.();
    try {
      await deps.tryResumeParentFromAsyncTool({ parentOperationId: operationId });
    } catch (selfCheckError) {
      log(
        '[%s][%d] Park-time async-tool self-check failed (non-fatal): %O',
        operationId,
        stepIndex,
        selfCheckError,
      );
    }
  }

  // Follow-ups the user queued behind this run start as the next turn right
  // here, instead of after the client hears the run ended and sends them
  // itself. Only after the hooks above: they persist the terminal row and
  // release the topic, which the next turn has to claim. A parked run keeps
  // its queue until it really ends; a failed or stopped one leaves it to the
  // user.
  const steerScope = steerQueueScopeOf(stepResult.newState, deps.userId);
  if (stepResult.newState.status === 'done' && steerScope && deps.delegate.startQueuedFollowUp) {
    try {
      await deps.delegate.startQueuedFollowUp({ operationId, scope: steerScope });
    } catch (error) {
      log(
        '[%s][%d] Starting queued follow-ups failed (non-fatal): %O',
        operationId,
        stepIndex,
        error,
      );
    }
  }
}

/** What the lifecycle-only replay reads off the service. */
export type CompletionReplayDeps = StepCompletionDeps &
  Pick<AgentRuntimeServiceContext, 'queryStepEntryMessages'>;

/**
 * Hatchet only: finish the completion lifecycle a terminal run still owes —
 * its attempt saved the terminal state, then died or failed to publish a
 * critical hook, and the delivery came back. Only the completion tail of
 * `finishOperation` runs again: never beforeStep, the LLM, tools, afterStep or
 * saveStepResult. The delivered step may be older than the one that finished
 * the run (an inline loop carries the delivery it started from); holding the
 * lock is what makes this the only invocation executing the operation.
 */
export async function replayPendingCompletionLifecycle(
  deps: CompletionReplayDeps,
  {
    agentState,
    assertOwnership,
    externalRetryCount,
    invokeAgentSpan,
    operationId,
  }: {
    agentState: AgentState;
    assertOwnership?: () => Promise<void>;
    externalRetryCount: number;
    invokeAgentSpan: Span;
    operationId: string;
  },
): Promise<AgentExecutionResult | undefined> {
  if (!owesCompletionLifecycle(agentState)) return undefined;
  const { stepIndex } = readCompletionCheckpoint(agentState)!;

  agentState.metadata = { ...agentState.metadata, externalRetryCount };
  // The persisted blob drops `messages`; the hooks read the final reply and its
  // attachments off them, the verify gate the goal. Hydrate as a step entry does.
  await deps.queryStepEntryMessages(agentState);

  await finishOperation(deps, {
    assertOwnership,
    invokeAgentSpan,
    operationId,
    stepIndex,
    stepResult: { events: [], newState: agentState },
  });

  log('[%s][%d] Replayed pending completion lifecycle', operationId, stepIndex);
  return { nextStepScheduled: false, state: agentState, stepResult: null, success: true };
}

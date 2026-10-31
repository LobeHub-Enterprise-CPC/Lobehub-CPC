import type { Span } from '@lobechat/observability-otel/api';
import { SpanStatusCode } from '@lobechat/observability-otel/api';
import { buildInvokeAgentResultAttributes } from '@lobechat/observability-otel/modules/agent-runtime';
import debug from 'debug';

import { formatErrorForState } from '@/server/modules/AgentRuntime/formatErrorForState';
import { isHatchetDeliveryEnabled } from '@/server/modules/Hatchet/config';

import { CriticalAgentInterventionPersistenceError } from '../../CompletionLifecycle';
import { logToolCallPc } from '../../formalObservation';
import { StepLockUnavailableError, StepOwnershipLostError } from '../executionErrors';
import type { AgentRuntimeServiceContext } from '../types';
import {
  markCompletionLifecyclePending,
  owesCompletionLifecycle,
  recordCompletionLifecycleCompleted,
} from './completion';

const log = debug('lobe-server:agent-runtime-service');

/** What this module reads off the service. */
export type StepFailureDeps = Pick<
  AgentRuntimeServiceContext,
  'completionLifecycle' | 'coordinator' | 'streamManager' | 'traceRecorder'
>;

/**
 * A terminal state already saved: its lifecycle is owed (a critical hook failed
 * to publish, a write after the commit failed) or not claimed yet (a Stop that
 * landed between two steps, see `oweUnannouncedTerminalLifecycle`).
 */
const committedTerminalState = async (
  deps: StepFailureDeps,
  operationId: string,
): Promise<boolean> => {
  try {
    const state = await deps.coordinator.loadAgentState(operationId);
    return (
      owesCompletionLifecycle(state) ||
      state?.status === 'done' ||
      state?.status === 'error' ||
      state?.status === 'interrupted'
    );
  } catch (error) {
    log('[%s] Failed to read the state before settling the failure: %O', operationId, error);
    throw error;
  }
};

/**
 * A step threw. Record it on the span, persist the error state, settle the
 * completion lifecycle and finalize the trace, then rethrow — except a failed
 * intervention Review publication, which keeps the run parked for the retry,
 * and on Hatchet a lost or unavailable step lock or an already terminal run,
 * which stay as they are for the redelivery.
 */
export async function failStep(
  deps: StepFailureDeps,
  {
    assertOwnership,
    error,
    externalRetryCount,
    invokeAgentSpan,
    operationId,
    stepIndex,
    stepStartAt,
  }: {
    assertOwnership?: () => Promise<void>;
    error: unknown;
    externalRetryCount: number;
    invokeAgentSpan: Span;
    operationId: string;
    stepIndex: number;
    stepStartAt: number;
  },
): Promise<never> {
  const isInterventionPersistenceFailure =
    error instanceof CriticalAgentInterventionPersistenceError;
  invokeAgentSpan.recordException(error as Error);
  invokeAgentSpan.setStatus({
    code: SpanStatusCode.ERROR,
    message: error instanceof Error ? error.message : String(error),
  });
  invokeAgentSpan.setAttributes(
    buildInvokeAgentResultAttributes({
      completionReason: isInterventionPersistenceFailure ? 'waiting_for_human' : 'error',
    }),
  );

  log('Step %d failed for operation %s: %O', stepIndex, operationId, error);

  // The runtime step and its waiting_for_human state are already durable;
  // only the idempotent generic Review publication failed. Turning this
  // infrastructure failure into an agent error would overwrite the parked
  // state/operation row and make the QStash redelivery terminal-short-circuit.
  // Preserve the parked state and propagate non-2xx so the completed-step
  // lifecycle replay above can retry Review persistence without repeating
  // any LLM or tool side effects.
  if (isInterventionPersistenceFailure) {
    log(
      '[%s][%d] Intervention Review persistence failed; keeping operation parked for retry',
      operationId,
      stepIndex,
    );
    throw error;
  }

  // Hatchet lock failures say nothing about the run, only that this attempt
  // may not run or commit the step. The delivery comes back; settling the run
  // as an error here would end it under whoever owns it now.
  if (error instanceof StepOwnershipLostError || error instanceof StepLockUnavailableError) {
    log('[%s][%d] Step lock lost or unavailable; leaving the run as it is', operationId, stepIndex);
    throw error;
  }

  // Hatchet: the run already saved its terminal state, so only its completion
  // lifecycle can be left to do. Keep that outcome (a user's Stop is not turned
  // into an error); the redelivery replays or claims the lifecycle.
  if (isHatchetDeliveryEnabled() && (await committedTerminalState(deps, operationId))) {
    log(
      '[%s][%d] Run already terminal, its completion lifecycle left to the retry',
      operationId,
      stepIndex,
    );
    throw error;
  }

  await assertOwnership?.();
  const formattedError = formatErrorForState(error);

  const publishErrorEvent = async () => {
    try {
      await deps.streamManager.publishStreamEvent(operationId, {
        data: {
          error: formattedError.message,
          errorType: String(formattedError.type),
          phase: 'step_execution',
          stepIndex,
        },
        stepIndex,
        type: 'error',
      });
    } catch (publishError) {
      log('[%s] Failed to publish error event (infra may be down): %O', operationId, publishError);
    }
  };
  // A client takes this event as the run's end. On Hatchet a failure below
  // retries the delivery and the run goes on, so the event waits for the
  // error state to be written (still ahead of the end of the stream).
  if (!isHatchetDeliveryEnabled()) await publishErrorEvent();

  // Build error state — try loading current state from coordinator, but if that
  // also fails (e.g. Redis ECONNRESET), fall back to a minimal error state so
  // that completion callbacks and webhooks can still fire.
  let finalStateWithError: any;
  try {
    const errorState = await deps.coordinator.loadAgentState(operationId);
    finalStateWithError = {
      ...errorState!,
      error: formattedError,
      metadata: {
        ...errorState?.metadata,
        externalRetryCount,
      },
      status: 'error' as const,
      stepCount: errorState?.stepCount ?? stepIndex,
    };
  } catch (loadError) {
    if (isHatchetDeliveryEnabled()) throw loadError;
    log('[%s] Failed to load error state (infra may be down): %O', operationId, loadError);
    // Fallback: construct a minimal error state so callbacks still receive useful info
    finalStateWithError = {
      error: formattedError,
      metadata: { externalRetryCount },
      status: 'error' as const,
      stepCount: stepIndex,
    };
  }

  // Hatchet: the error notification is as critical as a normal completion's,
  // so it is owed from the same write and replayed the same way.
  markCompletionLifecyclePending(finalStateWithError, stepIndex);

  await assertOwnership?.();
  try {
    if (isHatchetDeliveryEnabled()) {
      await deps.coordinator.saveAgentState(
        operationId,
        finalStateWithError,
        assertOwnership,
        publishErrorEvent,
      );
    } else {
      await deps.coordinator.saveAgentState(operationId, finalStateWithError, assertOwnership);
    }
  } catch (saveError) {
    if (isHatchetDeliveryEnabled()) throw saveError;
    log('[%s] Failed to save error state (infra may be down): %O', operationId, saveError);
  }

  await deps.completionLifecycle.emitSignalEvents(operationId, finalStateWithError, 'error');
  logToolCallPc(operationId, stepIndex, 'post.completion_signals', () => ({ reason: 'error' }));

  // Dispatch onComplete + onError hooks
  if (isHatchetDeliveryEnabled()) {
    await deps.completionLifecycle.dispatchHooks(operationId, finalStateWithError, 'error', {
      assertOwnership,
      strict: true,
    });
  } else {
    await deps.completionLifecycle.dispatchHooks(operationId, finalStateWithError, 'error');
  }
  logToolCallPc(operationId, stepIndex, 'post.completion_hooks', () => ({ reason: 'error' }));
  await assertOwnership?.();
  await recordCompletionLifecycleCompleted(deps, operationId, finalStateWithError, assertOwnership);

  // Finalize the partial snapshot into the canonical S3 path so the
  // failed op is observable in the same place as a successful run.
  // Without this, propagated errors (e.g. markPersistFatal from
  // RuntimeExecutors) leave the partial as an orphan at
  // `_partial/<op>.json.zst` and the canonical
  // `agent-traces/<agentId>/<topicId>/<op>.json.zst` returns 404 — see
  // .
  //
  // `failedStep` synthesizes a step record for the failure because the
  // real step never reached `appendStepToPartial` — it threw before the
  // success path could push it. Without this synthetic step, the
  // snapshot's step count would lag the assistant message that
  // triggered the failing call.
  await assertOwnership?.();
  await deps.traceRecorder.finalize(operationId, {
    assertOwnership,
    completionReason: 'error',
    error: {
      attribution: formattedError.attribution,
      body: formattedError.body,
      category: formattedError.category,
      countAsFailure: formattedError.countAsFailure,
      httpStatus: formattedError.httpStatus,
      message: formattedError.message ?? String(formattedError.type),
      numericId: formattedError.numericId,
      retryable: formattedError.retryable,
      severity: formattedError.severity,
      type: String(formattedError.type),
    },
    failedStep: {
      startedAt: stepStartAt,
      stepIndex,
      stepType: formattedError.category === 'provider' ? 'call_llm' : 'call_tool',
    },
    state: finalStateWithError,
  });
  logToolCallPc(operationId, stepIndex, 'post.trace_finalized', () => ({ reason: 'error' }));

  throw error;
}

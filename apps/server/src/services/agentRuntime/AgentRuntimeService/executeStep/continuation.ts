import debug from 'debug';

import { logToolCallPc } from '../../formalObservation';
import { type AgentStepContinuation } from '../../types';
import type { AgentRuntimeServiceContext } from '../types';
import type { StepRunResult } from './runStep';

const log = debug('lobe-server:agent-runtime-service');

/** What this module reads off the service. */
export type StepContinuationDeps = Pick<
  AgentRuntimeServiceContext,
  | 'baseURL'
  | 'calculatePriority'
  | 'calculateStepDelay'
  | 'coordinator'
  | 'queueService'
  | 'streamManager'
  | 'traceRecorder'
>;

const nextStepOf = (
  deps: StepContinuationDeps,
  operationId: string,
  stepIndex: number,
  stepResult: StepRunResult,
): AgentStepContinuation | undefined => {
  if (!stepResult.nextContext) return;
  return {
    context: stepResult.nextContext,
    delay: deps.calculateStepDelay(stepResult),
    operationId,
    priority: deps.calculatePriority(stepResult),
    retries:
      typeof stepResult.newState.host?.queue?.retries === 'number'
        ? stepResult.newState.host?.queue?.retries
        : undefined,
    retryDelay:
      typeof stepResult.newState.host?.queue?.retryDelay === 'string'
        ? stepResult.newState.host?.queue?.retryDelay
        : undefined,
    stepIndex: stepIndex + 1,
  };
};

/**
 * Hatchet: the step is committed but this attempt lost the lock before handing
 * the next one on. Queue it anyway, skipping what needs the lock (the trace,
 * the inline envelope): the redelivery of this step is ACKed as already done,
 * so nothing else would run the rest of the operation until the stale reaper.
 * A duplicate is dropped by the next claim and the stale-step guard.
 */
export async function queueNextStepAfterOwnershipLoss(
  deps: StepContinuationDeps,
  {
    operationId,
    stepIndex,
    stepResult,
  }: { operationId: string; stepIndex: number; stepResult: StepRunResult },
): Promise<void> {
  const next = nextStepOf(deps, operationId, stepIndex, stepResult);
  if (!next || !deps.queueService) return;
  try {
    await deps.queueService.scheduleMessage({ ...next, endpoint: `${deps.baseURL}/run` });
    log(
      '[%s][%d] Lost the lock after the commit; queued step %d',
      operationId,
      stepIndex,
      stepIndex + 1,
    );
  } catch (error) {
    log(
      '[%s][%d] Could not queue the next step after losing the lock: %O',
      operationId,
      stepIndex,
      error,
    );
  }
}

/**
 * Hand the next step back to the caller (inline) or queue it. Inlining needs
 * the envelope parked first, so a redelivery can recover the run when this
 * invocation dies mid-step.
 */
export async function scheduleNextStep(
  deps: StepContinuationDeps,
  {
    assertOwnership,
    inlineContinuation,
    operationId,
    stepIndex,
    stepResult,
  }: {
    assertOwnership?: () => Promise<void>;
    inlineContinuation: boolean;
    operationId: string;
    stepIndex: number;
    stepResult: StepRunResult;
  },
): Promise<{
  continuation: AgentStepContinuation | undefined;
  handedOffInline: boolean;
  nextStepScheduled: boolean;
}> {
  let continuation: AgentStepContinuation | undefined;
  let handedOffInline = false;
  let nextStepScheduled = false;

  // The caller checks both; repeated here for the type narrowing.
  const next = nextStepOf(deps, operationId, stepIndex, stepResult);
  if (!deps.queueService || !next) {
    return { continuation, handedOffInline, nextStepScheduled };
  }

  const nextStepIndex = next.stepIndex;

  // Park the envelope before handing it over. The caller is about to run
  // this step in-process with nothing queued behind it; if that
  // invocation dies mid-step, the only way back is for a redelivery to
  // find this envelope — the stale-delivery guard would otherwise ACK
  // the (now older) delivered step and strand the operation.
  //
  // Inlining is therefore conditional on the park succeeding. When it
  // doesn't, fall back to the ordinary queue round-trip: slower by a
  // step boundary, but it keeps the recovery path the queue provides.
  const parked = inlineContinuation
    ? await deps.coordinator.saveInlineResume(operationId, next, assertOwnership)
    : false;

  if (!parked && inlineContinuation) {
    log(
      '[%s][%d] Could not park the inline envelope; falling back to the queue',
      operationId,
      stepIndex,
    );
  }

  if (parked) {
    handedOffInline = true;
    // Hand the next step back to the caller instead of paying a full
    // queue round-trip for it. The caller either runs it in this same
    // invocation or publishes it via `scheduleContinuation` when its
    // time budget runs out, so the step is never dropped.
    continuation = next;
    logToolCallPc(operationId, stepIndex, 'post.next_step_inlined', () => ({
      nextStepIndex,
    }));
    log('[%s][%d] Next step %d deferred to caller', operationId, stepIndex, nextStepIndex);
  } else {
    // The next step runs in another invocation, which rebuilds the
    // partial from the store — it has to see this step. The gateway
    // pushes this invocation issued have to land for the same reason:
    // nothing carries them once it stops running.
    await assertOwnership?.();
    await deps.traceRecorder.flushPartial();
    await deps.streamManager.drainPushes?.(operationId);
    await assertOwnership?.();
    await deps.queueService.scheduleMessage({ ...next, endpoint: `${deps.baseURL}/run` });
    nextStepScheduled = true;
    logToolCallPc(operationId, stepIndex, 'post.next_step_scheduled', () => ({
      nextStepIndex,
    }));

    log('[%s][%d] Scheduled next step %d', operationId, stepIndex, nextStepIndex);
  }

  return { continuation, handedOffInline, nextStepScheduled };
}

import { context as otelContext, trace as otelTrace } from '@lobechat/observability-otel/api';
import {
  buildInvokeAgentAttributes,
  buildInvokeAgentResultAttributes,
  invokeAgentSpanName,
  tracer as agentRuntimeTracer,
} from '@lobechat/observability-otel/modules/agent-runtime';
import debug from 'debug';

import { isHatchetDeliveryEnabled } from '@/server/modules/Hatchet/config';
import { assertGatewayStateExecution } from '@/server/services/gatewayAuthorization/operationAuthority';

import {
  type AgentExecutionParams,
  type AgentExecutionResult,
  type AgentStepContinuation,
} from '../../types';
import { STEP_LOCK_TTL_SECONDS } from '../constants';
import { StepOwnershipLostError } from '../executionErrors';
import type { AgentRuntimeServiceContext } from '../types';
import { createStepLockOwner } from '../utils';
import { startStepAbortPoll, type StepAbortPoll } from './abortPoll';
import {
  finishOperation,
  markCompletionLifecyclePending,
  oweUnannouncedTerminalLifecycle,
  replayPendingCompletionLifecycle,
} from './completion';
import { queueNextStepAfterOwnershipLoss, scheduleNextStep } from './continuation';
import { failStep } from './failure';
import {
  handleStepLockConflict,
  replayPendingInterventionLifecycle,
  runLockFreeDelivery,
  skipUnrunnableStep,
} from './guards';
import { dispatchAfterStepHooks, dispatchBeforeStepHooks, persistStepTracking } from './hooks';
import { prepareStepInput } from './prepare';
import { runAndReconcileStep, saveAndPublishStep } from './runStep';

const log = debug('lobe-server:agent-runtime-service');

/** What this module reads off the service. */
export type ExecuteStepDeps = Pick<
  AgentRuntimeServiceContext,
  | 'agentOperationModel'
  | 'baseURL'
  | 'buildShareAbortResult'
  | 'calculatePriority'
  | 'calculateStepDelay'
  | 'completionLifecycle'
  | 'computeDeviceContext'
  | 'coordinator'
  | 'createAgentRuntime'
  | 'delegate'
  | 'determineCompletionReason'
  | 'expireClientLlmWait'
  | 'handleGroupMemberTimeout'
  | 'humanIntervention'
  | 'injectQueuedFollowUp'
  | 'parkForClientLlm'
  | 'publishSubAgentProgress'
  | 'queryStepEntryMessages'
  | 'queryUiMessages'
  | 'queueService'
  | 'readQueuedMessagesFlag'
  | 'recordInterventionLifecycleCompletion'
  | 'refreshMessagesFromDB'
  | 'resolveAsyncToolResumeParentMessageId'
  | 'serverDB'
  | 'shouldContinueExecution'
  | 'shouldReplayPendingInterventionLifecycle'
  | 'startStepLockHeartbeat'
  | 'streamManager'
  | 'traceRecorder'
  | 'tryResumeParentFromAsyncTool'
  | 'userId'
  | 'usesGatewayMessagePatch'
  | 'workspaceId'
>;

/**
 * Hatchet: commit only while this attempt still owns the operation — the
 * heartbeat never found the lock taken, and a refresh right before the save
 * still finds it ours (a refresh that cannot reach Redis refuses too).
 *
 * Not atomic with the save: a lock that expires between this refresh and the
 * authoritative write can still let a second owner commit. Nor are LLM or tool
 * calls already in flight interrupted when the lock goes; losing it only stops
 * the commit.
 */
async function assertStepOwnership(
  deps: ExecuteStepDeps,
  {
    heartbeatLostLock,
    operationId,
    stepIndex,
    stepLockOwner,
  }: {
    heartbeatLostLock: () => boolean;
    operationId: string;
    stepIndex: number;
    stepLockOwner: string;
  },
): Promise<void> {
  const lost = (cause?: unknown) => {
    deps.traceRecorder.discardPartial();
    return new StepOwnershipLostError(operationId, stepIndex, { cause });
  };
  if (heartbeatLostLock()) throw lost();

  let refreshed: boolean;
  try {
    refreshed = await deps.coordinator.refreshStepLock(
      operationId,
      stepIndex,
      STEP_LOCK_TTL_SECONDS,
      stepLockOwner,
    );
  } catch (error) {
    throw lost(error);
  }
  if (!refreshed || heartbeatLostLock()) throw lost();
}

/**
 * Execute Agent step
 */
export async function executeStep(
  deps: ExecuteStepDeps,
  params: AgentExecutionParams,
): Promise<AgentExecutionResult> {
  const {
    operationId,
    stepIndex,
    resumeClientLlm,
    externalRetryCount = 0,
    inlineContinuation = false,
    retainStepLock = false,
    stepLockOwner: providedStepLockOwner,
  } = params;

  const hatchetDelivery = isHatchetDeliveryEnabled();

  const lockFree = await runLockFreeDelivery(deps, params);
  if (lockFree) return lockFree;

  // ===== Distributed lock: prevent duplicate execution from QStash retries =====
  // On Hatchet a Redis failure here throws (StepLockUnavailableError) instead
  // of claiming: it is outside the try below, so no error state is written.
  const stepLockOwner = providedStepLockOwner ?? createStepLockOwner(operationId, stepIndex);
  const claimed = await deps.coordinator
    .tryClaimStep(operationId, stepIndex, STEP_LOCK_TTL_SECONDS, stepLockOwner)
    .catch((error) => {
      if (hatchetDelivery) deps.traceRecorder.discardPartial();
      throw error;
    });
  if (!claimed) return handleStepLockConflict(deps, params);

  // Load tests read when an attempt took a step over from this line: ids only.
  if (hatchetDelivery) {
    console.info(
      JSON.stringify({
        event: 'agent.step.claimed',
        operationId,
        stepIndex,
        externalRetryCount,
        at: Date.now(),
      }),
    );
  }

  await deps.agentOperationModel.touchRunning(operationId).catch((error) => {
    log('[%s][%d] Operation lease refresh failed: %O', operationId, stepIndex, error);
  });
  let heartbeatLostLock = false;
  const stopStepLockHeartbeat = hatchetDelivery
    ? deps.startStepLockHeartbeat(operationId, stepIndex, stepLockOwner, () => {
        heartbeatLostLock = true;
        deps.traceRecorder.discardPartial();
      })
    : deps.startStepLockHeartbeat(operationId, stepIndex, stepLockOwner);

  const assertOwnership = hatchetDelivery
    ? () =>
        assertStepOwnership(deps, {
          heartbeatLostLock: () => heartbeatLostLock,
          operationId,
          stepIndex,
          stepLockOwner,
        })
    : undefined;

  // Hoisted so the shared `finally` can stop it on every exit path — an
  // orphaned poll would keep reading Redis for a step that is long gone.
  let abortPoll: StepAbortPoll | undefined;

  // Hoisted so the error-path snapshot finalize can record an
  // approximate startedAt for the failing step. The inner `startAt` at the
  // runtime.step() call site stays as the authoritative start for the
  // success path.
  const stepStartAt = Date.now();

  // Hoisted so the shared `finally` knows whether the next step stays in this
  // invocation. When it does, the accumulated trace partial stays in memory;
  // on every other exit some other process reads it, so it has to be durable.
  let handedOffInline = false;

  // OTel invoke_agent span. Wraps the entire step body so child spans
  // (chat / execute_tool / context_engineering) auto-nest via the active
  // context. Started with minimal attrs; agent/model/topic are added once
  // agentState is loaded.
  const invokeAgentSpan = agentRuntimeTracer.startSpan(invokeAgentSpanName(), {
    attributes: buildInvokeAgentAttributes({ operationId, stepIndex }),
  });
  const invokeAgentCtx = otelTrace.setSpan(otelContext.active(), invokeAgentSpan);

  try {
    return await otelContext.with(invokeAgentCtx, async () => {
      log('[%s][%d] Start step executing...', operationId, stepIndex);

      // Load agent state BEFORE publishing step_start so we can attach the
      // canonical UIChatMessage snapshot to the event payload. step_start
      // fires after the previous step's DB writes are awaited durable, so
      // the snapshot query here reflects strongly-consistent state — that's
      // the contract that lets the client treat the pushed uiMessages as
      // the source of truth instead of doing its own refetch.
      const agentState = await deps.coordinator.loadAgentState(operationId);

      if (!agentState) {
        throw new Error(`Agent state not found for operation ${operationId}`);
      }
      await assertGatewayStateExecution(operationId, agentState.execution);

      const replayed = await replayPendingInterventionLifecycle(deps, {
        agentState,
        assertOwnership,
        externalRetryCount,
        operationId,
        stepIndex,
      });
      if (replayed) return replayed;

      // A Stop between two steps left a terminal state nobody announced.
      await oweUnannouncedTerminalLifecycle(deps, {
        agentState,
        assertOwnership,
        operationId,
        stepIndex,
      });
      const replayedCompletion = await replayPendingCompletionLifecycle(deps, {
        agentState,
        assertOwnership,
        externalRetryCount,
        invokeAgentSpan,
        operationId,
      });
      if (replayedCompletion) return replayedCompletion;

      const gatewayMessagePatchEnabled = deps.usesGatewayMessagePatch(agentState);
      const { uiMessages: stepStartUiMessages, messages: stepEntryMessages } =
        await deps.queryStepEntryMessages(agentState);
      await deps.streamManager.publishStreamEvent(operationId, {
        data: gatewayMessagePatchEnabled
          ? { messageRevision: stepIndex }
          : { ...(stepStartUiMessages !== undefined && { uiMessages: stepStartUiMessages }) },
        stepIndex,
        type: 'step_start',
      });

      agentState.metadata = {
        ...agentState.metadata,
        externalRetryCount,
      };

      // Enrich invoke_agent span with agent identity now that state is loaded.
      const stateAgentConfig = agentState.world?.agent as
        { description?: string | null; title?: string | null } | undefined;
      const stateModel = agentState.modelRuntimeConfig?.model;
      const stateProvider = agentState.modelRuntimeConfig?.provider;
      invokeAgentSpan.updateName(invokeAgentSpanName(stateAgentConfig?.title ?? undefined));
      invokeAgentSpan.setAttributes(
        buildInvokeAgentAttributes({
          agentDescription: stateAgentConfig?.description ?? undefined,
          agentId: agentState.origin?.agentId,
          agentName: stateAgentConfig?.title ?? undefined,
          conversationId: agentState.origin?.topicId,
          operationId,
          provider: stateProvider,
          requestModel: stateModel,
          stepIndex,
        }),
      );

      const skipped = await skipUnrunnableStep(deps, {
        agentState,
        assertOwnership,
        operationId,
        resumeClientLlm,
        stepIndex,
      });
      if (skipped) return skipped;

      const beforeStepSignalEvents = await dispatchBeforeStepHooks(deps, {
        agentState,
        operationId,
        stepIndex,
      });

      // Per-step buffer for context engine input/output. Populated by the
      // `tracingContextEngine` callback passed into the executor context;
      // consumed by traceRecorder.appendStep below. Routing CE this way keeps
      // its heavy payload (agentDocuments, systemRole, …) out of
      // `stepResult.events` and therefore out of the Redis state pipeline.
      //
      // Context: contextEngine.input (agentDocuments) was ~2.7MB/step,
      // hitting Upstash Redis 10MB limit. Bypassing events keeps the heavy
      // payload in trace only, reducing per-step Redis state by ~500x.
      let contextEnginePayload: { input: unknown; metadata?: unknown; output: unknown } | undefined;

      // Create Agent and Runtime instances
      // Use agentState.metadata which contains the full app context (topicId, agentId, etc.)
      // operationMetadata only contains basic fields (agentConfig, modelRuntimeConfig, userId)
      abortPoll = startStepAbortPoll(deps, operationId, stepIndex, agentState.execution);

      const { runtime } = await deps.createAgentRuntime({
        abortSignal: abortPoll.signal,
        agentState,
        operationId,
        stepIndex,
        tracingContextEngine: (input, output, metadata) => {
          contextEnginePayload = { input, metadata, output };
        },
      });

      const input = await prepareStepInput(deps, { agentState, params, stepEntryMessages });
      const { currentContext } = input;

      const { startAt, stepResult } = await runAndReconcileStep(deps, {
        ...input,
        assertOwnership,
        operationId,
        runtime,
        stepIndex,
      });

      if (hatchetDelivery) {
        // A terminal step saves its completion lifecycle as owed in the same write.
        markCompletionLifecyclePending(stepResult.newState, stepIndex);
      }

      const { content, shouldContinue, stepPresentationData, toolsCalling } =
        await saveAndPublishStep(deps, {
          assertOwnership,
          gatewayMessagePatchEnabled,
          operationId,
          startAt,
          stepIndex,
          stepResult,
          stepStartUiMessages,
        });

      let nextStepScheduled = false;
      let continuation: AgentStepContinuation | undefined;
      // The step is committed: its redelivery is ACKed as already done, so a
      // lock lost from here on must still hand the next step on.
      try {
        const afterStepSignalEvents = await dispatchAfterStepHooks(deps, {
          content,
          operationId,
          shouldContinue,
          stepIndex,
          stepPresentationData,
          stepResult,
          toolsCalling,
        });

        await assertOwnership?.();
        await deps.traceRecorder.appendStep(operationId, {
          afterStepSignalEvents,
          agentState,
          beforeStepSignalEvents,
          contextEngine: contextEnginePayload,
          currentContext,
          externalRetryCount,
          presentation: stepPresentationData,
          startedAt: startAt,
          stepIndex,
          stepResult,
        });

        await persistStepTracking(deps, {
          assertOwnership,
          content,
          operationId,
          shouldContinue,
          stepIndex,
          stepResult,
          toolsCalling,
        });

        if (shouldContinue && stepResult.nextContext && deps.queueService) {
          const scheduled = await scheduleNextStep(deps, {
            assertOwnership,
            inlineContinuation,
            operationId,
            stepIndex,
            stepResult,
          });
          continuation = scheduled.continuation;
          nextStepScheduled = scheduled.nextStepScheduled;
          if (scheduled.handedOffInline) handedOffInline = true;
        }
      } catch (error) {
        if (error instanceof StepOwnershipLostError && shouldContinue && !nextStepScheduled) {
          await queueNextStepAfterOwnershipLoss(deps, { operationId, stepIndex, stepResult });
        }
        throw error;
      }

      // Record final agent-level usage on the invoke_agent span. Done on every
      // step so partial trees (e.g. interrupted runs) still carry the
      // last-known token counters.
      invokeAgentSpan.setAttributes(
        buildInvokeAgentResultAttributes({
          inputTokens: stepResult.newState.usage?.llm?.tokens?.input,
          outputTokens: stepResult.newState.usage?.llm?.tokens?.output,
          stepCount: stepResult.newState.stepCount,
        }),
      );

      if (!shouldContinue) {
        await finishOperation(deps, {
          assertOwnership,
          invokeAgentSpan,
          operationId,
          stepIndex,
          stepResult,
        });
      }

      return {
        continuation,
        nextStepScheduled,
        state: stepResult.newState,
        stepResult,
        success: true,
      };
    });
  } catch (error) {
    return await failStep(deps, {
      assertOwnership,
      error,
      externalRetryCount,
      invokeAgentSpan,
      operationId,
      stepIndex,
      stepStartAt,
    });
  } finally {
    invokeAgentSpan.end();
    abortPoll?.stop();
    stopStepLockHeartbeat();
    // Parked runs (human input, async tools) and finished ones are read back
    // by a different invocation, so the partial cannot stay in memory only.
    // An inline hand-off keeps it: the next step runs on this recorder.
    if (!handedOffInline) {
      await deps.traceRecorder.flushPartial();
      // Same boundary for the stream: an issued push is only guaranteed to
      // reach the gateway while this invocation is still running.
      await deps.streamManager.drainPushes?.(operationId);
    }
    // The inline step loop keeps the lock across step boundaries — releasing
    // here would open a window for a stale redelivery to claim it mid-run.
    // Its caller releases once, in a `finally`, for the whole invocation.
    if (!retainStepLock) {
      await deps.coordinator.releaseStepLock(operationId, stepIndex, stepLockOwner);
    }
  }
}

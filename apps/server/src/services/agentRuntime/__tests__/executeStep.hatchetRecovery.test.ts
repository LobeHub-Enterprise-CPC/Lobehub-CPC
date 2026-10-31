// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

import type * as HatchetConfig from '@/server/modules/Hatchet/config';
import * as verifyServices from '@/server/services/verify';

import { StepOwnershipLostError } from '../AgentRuntimeService/executionErrors';
import { hookDispatcher } from '../hooks';
import {
  CHECKPOINT,
  holdHeartbeat,
  OPERATION_ID,
  queueWith,
  runningState,
  setUp,
  STEP_CONTEXT,
} from './testUtils';

const hatchet = vi.hoisted(() => ({ enabled: true }));

vi.mock('@/server/modules/Hatchet/config', async (importOriginal) => ({
  ...(await importOriginal<typeof HatchetConfig>()),
  isHatchetDeliveryEnabled: () => hatchet.enabled,
}));

// Callbacks are addressed to the test tenant `acme` (see __mocks__/callbackUrl).
vi.mock('@/server/modules/Tenant/callbackUrl');

// Same isolation as executeStep.hatchetDelivery.test.ts: only the step
// orchestration (and, where a test asks for it, the completion lifecycle) is real.
vi.mock('@/envs/app', () => ({ appEnv: { APP_URL: 'http://localhost:3010' } }));
vi.mock('@/database/models/message', () => ({
  MessageModel: vi.fn(function () {
    return { query: vi.fn().mockResolvedValue([]) };
  }),
}));
vi.mock('@/server/modules/AgentRuntime', () => ({
  AgentRuntimeCoordinator: vi.fn(function () {
    return {
      createAgentOperation: vi.fn(),
      getOperationMetadata: vi.fn(),
      hasQueuedMessages: vi.fn().mockResolvedValue(false),
      isInterrupted: vi.fn().mockResolvedValue(false),
      loadAgentState: vi.fn(),
      refreshStepLock: vi.fn().mockResolvedValue(true),
      releaseStepLock: vi.fn().mockResolvedValue(undefined),
      saveAgentState: vi.fn(),
      saveStepResult: vi.fn(),
      tryClaimStep: vi.fn().mockResolvedValue(true),
    };
  }),
  createStreamEventManager: vi.fn(function () {
    return {
      cleanupOperation: vi.fn(),
      publishAgentRuntimeEnd: vi.fn(),
      publishAgentRuntimeInit: vi.fn(),
      publishStreamEvent: vi.fn(),
    };
  }),
}));
vi.mock('@/server/modules/AgentRuntime/RuntimeExecutors', () => ({
  createRuntimeExecutors: vi.fn(function () {
    return {};
  }),
}));
vi.mock('@/server/services/mcp', () => ({ mcpService: {} }));
vi.mock('@/server/services/queue', () => ({
  QueueService: vi.fn(function () {
    return {
      getImpl: vi.fn(function () {
        return {};
      }),
      scheduleMessage: vi.fn(),
    };
  }),
}));
vi.mock('@/server/services/queue/impls', () => ({
  LocalQueueServiceImpl: class {},
}));
vi.mock('@/server/services/toolExecution', () => ({
  ToolExecutionService: vi.fn(function () {
    return {};
  }),
}));
vi.mock('@/server/services/toolExecution/builtin', () => ({
  BuiltinToolsExecutor: vi.fn(function () {
    return {};
  }),
}));
vi.mock('@lobechat/builtin-tools/dynamicInterventionAudits', () => ({
  dynamicInterventionAudits: [],
}));

afterEach(() => {
  hatchet.enabled = true;
  vi.restoreAllMocks();
});

describe('executeStep (Hatchet) - a Stop that lands between two steps', () => {
  /**
   * The real completion lifecycle over one durable row, shared by the
   * service's and the lifecycle's operation models the way the database is.
   */
  const withDurableRow = (ctx: ReturnType<typeof setUp>, status: string) => {
    const row = { id: OPERATION_ID, status };
    const lifecycle = (ctx.service as any).completionLifecycle;
    ctx.dispatchHooks.mockRestore();
    vi.spyOn(verifyServices, 'settleFailedRepair').mockResolvedValue(false);
    vi.spyOn((ctx.service as any).agentOperationModel, 'findById').mockImplementation(async () => ({
      ...row,
    }));
    vi.spyOn(lifecycle.agentOperationModel, 'findById').mockImplementation(async () => ({
      ...row,
    }));
    vi.spyOn(lifecycle.agentOperationModel, 'sumChildUsage').mockResolvedValue(undefined);
    const recordCompletion = vi
      .spyOn(lifecycle.agentOperationModel, 'recordCompletion')
      .mockImplementation(async (_id: any, completion: any) => {
        row.status = completion.status;
        return true;
      });
    return { recordCompletion, row };
  };

  // `interruptOperation` writes only the Redis state; the next delivery is
  // what has to settle the run.
  const stoppedBetweenSteps = () => ({ ...runningState(), status: 'interrupted', stepCount: 1 });

  it('persists the stop and announces it once, then ACKs the redelivery', async () => {
    const ctx = setUp(stoppedBetweenSteps());
    const { recordCompletion, row } = withDurableRow(ctx, 'running');

    const result = await ctx.service.executeStep({
      context: STEP_CONTEXT,
      operationId: OPERATION_ID,
      stepIndex: 1,
    });

    expect(result).toMatchObject({
      state: { status: 'interrupted' },
      stepResult: null,
      success: true,
    });
    expect(recordCompletion).toHaveBeenCalledTimes(1);
    expect(recordCompletion).toHaveBeenCalledWith(
      OPERATION_ID,
      expect.objectContaining({ completionReason: 'interrupted', status: 'interrupted' }),
    );
    expect(row.status).toBe('interrupted');
    expect(ctx.hookCalls('onComplete')).toHaveLength(1);
    expect(ctx.hookCalls('onComplete')[0][2]).toMatchObject({ reason: 'interrupted' });
    expect(ctx.stored().metadata[CHECKPOINT]).toEqual({
      reason: 'interrupted',
      state: 'completed',
      stepIndex: 1,
    });
    expect(ctx.runtimeStep).not.toHaveBeenCalled();

    const redelivery = await ctx.service.executeStep({
      context: STEP_CONTEXT,
      externalRetryCount: 1,
      operationId: OPERATION_ID,
      stepIndex: 1,
    });

    expect(redelivery).toMatchObject({ state: { status: 'interrupted' }, success: true });
    expect(recordCompletion).toHaveBeenCalledTimes(1);
    expect(ctx.hookCalls('onComplete')).toHaveLength(1);
    expect(ctx.runtimeStep).not.toHaveBeenCalled();
  });

  it('keeps the stop owed when its announcement fails, and finishes it on the retry', async () => {
    const ctx = setUp(stoppedBetweenSteps());
    const { recordCompletion } = withDurableRow(ctx, 'running');
    recordCompletion.mockRejectedValueOnce(new Error('db down'));

    await expect(
      ctx.service.executeStep({ context: STEP_CONTEXT, operationId: OPERATION_ID, stepIndex: 1 }),
    ).rejects.toThrow('db down');

    expect(ctx.stored()).toMatchObject({ status: 'interrupted' });
    expect(ctx.stored().error).toBeUndefined();
    expect(ctx.stored().metadata[CHECKPOINT]).toEqual({
      reason: 'interrupted',
      state: 'pending',
      stepIndex: 1,
    });
    expect(ctx.hookCalls('onComplete')).toHaveLength(0);

    await ctx.service.executeStep({
      context: STEP_CONTEXT,
      externalRetryCount: 1,
      operationId: OPERATION_ID,
      stepIndex: 1,
    });

    expect(recordCompletion).toHaveBeenCalledTimes(2);
    expect(ctx.hookCalls('onComplete')).toHaveLength(1);
    expect(ctx.stored().metadata[CHECKPOINT].state).toBe('completed');
  });

  it('does not turn the stop into an error when the durable row cannot be read', async () => {
    const ctx = setUp(stoppedBetweenSteps());
    const { recordCompletion } = withDurableRow(ctx, 'running');
    // The early ACK check reads the row; the claim's own read fails.
    vi.mocked((ctx.service as any).agentOperationModel.findById)
      .mockResolvedValueOnce({ id: OPERATION_ID, status: 'running' })
      .mockRejectedValueOnce(new Error('db down'));

    await expect(
      ctx.service.executeStep({ context: STEP_CONTEXT, operationId: OPERATION_ID, stepIndex: 1 }),
    ).rejects.toThrow('db down');

    expect(ctx.stored()).toMatchObject({ status: 'interrupted' });
    expect(ctx.stored().error).toBeUndefined();
    expect(ctx.errorEvents()).toHaveLength(0);
    expect(ctx.hookCalls('onError')).toHaveLength(0);

    await ctx.service.executeStep({
      context: STEP_CONTEXT,
      externalRetryCount: 1,
      operationId: OPERATION_ID,
      stepIndex: 1,
    });

    expect(recordCompletion).toHaveBeenCalledTimes(1);
    expect(ctx.hookCalls('onComplete')).toHaveLength(1);
    expect(ctx.hookCalls('onComplete')[0][2]).toMatchObject({ reason: 'interrupted' });
  });

  it('still ACKs a stale duplicate of an earlier step without announcing anything', async () => {
    const ctx = setUp({ ...stoppedBetweenSteps(), stepCount: 2 });
    const { recordCompletion } = withDurableRow(ctx, 'running');

    const result = await ctx.service.executeStep({
      context: STEP_CONTEXT,
      operationId: OPERATION_ID,
      stepIndex: 1,
    });

    expect(result).toMatchObject({ stepResult: null, success: true });
    expect(recordCompletion).not.toHaveBeenCalled();
    expect(ctx.hookCalls('onComplete')).toHaveLength(0);
    expect(ctx.stored().metadata[CHECKPOINT]).toBeUndefined();
  });
});

describe('executeStep (Hatchet) - a lock lost after the step was committed', () => {
  const continuingStep = (ctx: ReturnType<typeof setUp>) =>
    ctx.runtimeStep.mockImplementationOnce(async (state: any) => ({
      events: [],
      newState: { ...state, status: 'running', stepCount: state.stepCount + 1 },
      nextContext: STEP_CONTEXT,
    }));

  it.each([
    [
      'the afterStep hooks',
      false,
      (_ctx: ReturnType<typeof setUp>, heartbeat: ReturnType<typeof holdHeartbeat>) => {
        vi.mocked(hookDispatcher.dispatch).mockImplementation(async (_id, type) => {
          if (type === 'afterStep') heartbeat.loseLock();
        });
      },
    ],
    [
      'parking the inline envelope',
      true,
      (ctx: ReturnType<typeof setUp>, heartbeat: ReturnType<typeof holdHeartbeat>) => {
        ctx.coordinator.saveInlineResume = vi.fn(
          async (_id: string, _envelope: unknown, assertOwnership?: () => Promise<void>) => {
            heartbeat.loseLock();
            await assertOwnership?.();
            return true;
          },
        );
      },
    ],
    [
      'the queue hand-off',
      false,
      (ctx: ReturnType<typeof setUp>, heartbeat: ReturnType<typeof holdHeartbeat>) => {
        vi.spyOn((ctx.service as any).traceRecorder, 'flushPartial').mockImplementationOnce(
          async () => heartbeat.loseLock(),
        );
      },
    ],
  ])(
    'still queues the next step when the lock goes during %s',
    async (_label, inlineContinuation, loseLockDuring) => {
      const scheduleMessage = vi.fn().mockResolvedValue('message-1');
      const ctx = setUp(runningState(), { queueService: queueWith(scheduleMessage) });
      const heartbeat = holdHeartbeat(ctx);
      const append = vi.spyOn((ctx.service as any).traceRecorder, 'appendStep');
      continuingStep(ctx);
      loseLockDuring(ctx, heartbeat);

      await expect(
        ctx.service.executeStep({
          context: STEP_CONTEXT,
          inlineContinuation,
          operationId: OPERATION_ID,
          stepIndex: 0,
        }),
      ).rejects.toBeInstanceOf(StepOwnershipLostError);

      expect(ctx.committed).toHaveLength(1);
      expect(scheduleMessage).toHaveBeenCalledTimes(1);
      expect(scheduleMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          context: STEP_CONTEXT,
          endpoint: expect.stringMatching(/\/run$/),
          operationId: OPERATION_ID,
          stepIndex: 1,
        }),
      );
      // The writes that need the lock stay skipped.
      expect(ctx.coordinator.saveAgentState).not.toHaveBeenCalled();
      expect(ctx.dispatchHooks).not.toHaveBeenCalled();
      expect(ctx.errorEvents()).toHaveLength(0);
      if (_label === 'the afterStep hooks') expect(append).not.toHaveBeenCalled();
    },
  );

  it('queues nothing when the lock goes before the commit', async () => {
    const scheduleMessage = vi.fn().mockResolvedValue('message-1');
    const ctx = setUp(runningState(), { queueService: queueWith(scheduleMessage) });
    const heartbeat = holdHeartbeat(ctx);
    ctx.runtimeStep.mockImplementationOnce(async (state: any) => {
      heartbeat.loseLock();
      return {
        events: [],
        newState: { ...state, status: 'running', stepCount: state.stepCount + 1 },
        nextContext: STEP_CONTEXT,
      };
    });

    await expect(
      ctx.service.executeStep({ context: STEP_CONTEXT, operationId: OPERATION_ID, stepIndex: 0 }),
    ).rejects.toBeInstanceOf(StepOwnershipLostError);

    expect(ctx.committed).toHaveLength(0);
    expect(scheduleMessage).not.toHaveBeenCalled();
  });
});

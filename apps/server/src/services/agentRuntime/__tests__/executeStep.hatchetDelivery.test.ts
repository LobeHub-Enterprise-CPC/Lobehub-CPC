// @vitest-environment node
import type { ISnapshotStore } from '@lobechat/agent-tracing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type * as HatchetConfig from '@/server/modules/Hatchet/config';

import { AgentRuntimeService } from '../AgentRuntimeService';
import { owesCompletionLifecycle } from '../AgentRuntimeService/executeStep/completion';
import {
  StepLockUnavailableError,
  StepOwnershipLostError,
} from '../AgentRuntimeService/executionErrors';
import { CriticalHookDeliveryError, hookDispatcher } from '../hooks';
import {
  CHECKPOINT,
  holdHeartbeat,
  OPERATION_ID,
  queueWith,
  runningState,
  setUp,
  STEP_CONTEXT,
  terminalState,
} from './testUtils';

const hatchet = vi.hoisted(() => ({ enabled: true }));

vi.mock('@/server/modules/Hatchet/config', async (importOriginal) => ({
  ...(await importOriginal<typeof HatchetConfig>()),
  isHatchetDeliveryEnabled: () => hatchet.enabled,
}));

// Callbacks are addressed to the test tenant `acme` (see __mocks__/callbackUrl).
vi.mock('@/server/modules/Tenant/callbackUrl');

// Same isolation as executeStep.test.ts: only the step orchestration is real.
vi.mock('@/envs/app', () => ({ appEnv: { APP_URL: 'http://localhost:3010' } }));
// Implementations go through `vi.fn(impl)` so `vi.restoreAllMocks()` keeps them.
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

describe('executeStep trace read overlap', () => {
  it.each(['heartbeat', 'refresh', 'claim'] as const)(
    'discards buffered trace when %s loses ownership before the old read resolves',
    async (mode) => {
      const traceRead = Promise.withResolvers<null>();
      const readStarted = Promise.withResolvers<void>();
      const store = {
        loadPartial: vi.fn(() => {
          readStarted.resolve();
          return traceRead.promise;
        }),
        removePartial: vi.fn().mockResolvedValue(undefined),
        save: vi.fn().mockResolvedValue(undefined),
        savePartial: vi.fn().mockResolvedValue({}),
      };
      const ctx = setUp(runningState(), {
        queueService: queueWith(vi.fn().mockResolvedValue(undefined)),
        snapshotStore: store as unknown as ISnapshotStore,
      });
      const heartbeat = holdHeartbeat(ctx);
      ctx.coordinator.saveInlineResume = vi.fn().mockResolvedValue(true);
      ctx.runtimeStep.mockImplementationOnce(async (state) => ({
        events: [],
        newState: { ...state, stepCount: 1 },
        nextContext: STEP_CONTEXT,
      }));
      const first = await ctx.service.executeStep({
        context: STEP_CONTEXT,
        inlineContinuation: true,
        retainStepLock: true,
        operationId: OPERATION_ID,
        stepIndex: 0,
      });
      expect(first.success).toBe(true);
      await readStarted.promise;
      const lost = Promise.withResolvers<void>();
      if (mode === 'heartbeat')
        ctx.runtimeStep.mockImplementationOnce(async () => {
          heartbeat.loseLock();
          lost.resolve();
          throw new Error('tool failed after losing ownership');
        });
      if (mode === 'refresh')
        ctx.coordinator.refreshStepLock.mockImplementationOnce(async () => {
          lost.resolve();
          return false;
        });
      if (mode === 'claim')
        ctx.coordinator.tryClaimStep.mockImplementationOnce(async () => {
          lost.resolve();
          throw new StepLockUnavailableError(OPERATION_ID);
        });
      const failed = ctx.service.executeStep({
        context: STEP_CONTEXT,
        inlineContinuation: true,
        retainStepLock: true,
        operationId: OPERATION_ID,
        stepIndex: 1,
      });
      const rejection = expect(failed).rejects.toBeInstanceOf(
        mode === 'claim' ? StepLockUnavailableError : StepOwnershipLostError,
      );
      await lost.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      traceRead.resolve(null);
      await rejection;
      await (ctx.service as any).traceRecorder.flushPartial();
      expect(store.savePartial).not.toHaveBeenCalled();
      expect(store.save).not.toHaveBeenCalled();
      expect(ctx.coordinator.saveStepResult).toHaveBeenCalledTimes(1);
      expect(ctx.stored()).toMatchObject({ status: 'running', stepCount: 1 });
    },
  );

  it('yields an inline continuation during a cold trace read but keeps queue handoff durable', async () => {
    const traceRead = Promise.withResolvers<null>();
    const readStarted = Promise.withResolvers<void>();
    const store = {
      loadPartial: vi.fn(() => {
        readStarted.resolve();
        return traceRead.promise;
      }),
      removePartial: vi.fn().mockResolvedValue(undefined),
      save: vi.fn().mockResolvedValue(undefined),
      savePartial: vi.fn().mockResolvedValue({}),
    };
    const scheduleMessage = vi.fn().mockResolvedValue(undefined);
    const ctx = setUp(runningState(), {
      queueService: queueWith(scheduleMessage),
      snapshotStore: store as unknown as ISnapshotStore,
    });
    ctx.coordinator.saveInlineResume = vi.fn().mockResolvedValue(true);
    ctx.runtimeStep.mockImplementationOnce(async (state) => ({
      events: [],
      newState: { ...state, stepCount: 1 },
      nextContext: STEP_CONTEXT,
    }));
    let boundaryReturned = false;
    const execution = ctx.service
      .executeStep({
        context: STEP_CONTEXT,
        inlineContinuation: true,
        retainStepLock: true,
        operationId: OPERATION_ID,
        stepIndex: 0,
      })
      .then((result) => {
        boundaryReturned = true;
        return result;
      });
    await readStarted.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    let handoff: Promise<void> | undefined;
    try {
      expect(boundaryReturned).toBe(true);
      expect(store.savePartial).not.toHaveBeenCalled();
      const result = await execution;
      expect(result.continuation).toBeDefined();
      handoff = ctx.service.scheduleContinuation(result.continuation!);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(scheduleMessage).not.toHaveBeenCalled();
    } finally {
      traceRead.resolve(null);
      await execution;
      await handoff;
    }
    expect(store.loadPartial).toHaveBeenCalledTimes(1);
    expect(store.savePartial.mock.calls.at(-1)?.[1].steps).toHaveLength(1);
    expect(store.savePartial.mock.invocationCallOrder[0]).toBeLessThan(
      scheduleMessage.mock.invocationCallOrder[0],
    );
  });
});

describe('executeStep (Hatchet) - owed completion lifecycle', () => {
  it('ignores a checkpoint belonging to a different terminal reason', () => {
    const state = terminalState('done', { state: 'pending', stepIndex: 0 });
    state.metadata[CHECKPOINT].reason = 'error';
    expect(owesCompletionLifecycle(state as any)).toBe(false);
  });

  it('marks the terminal commit as owed and settles the checkpoint once the hooks are out', async () => {
    const ctx = setUp(runningState());

    const result = await ctx.service.executeStep({
      context: STEP_CONTEXT,
      operationId: OPERATION_ID,
      stepIndex: 0,
    });

    expect(result).toMatchObject({ state: { status: 'done' }, success: true });
    expect(ctx.committed).toHaveLength(1);
    expect(ctx.committed[0].metadata[CHECKPOINT]).toEqual({
      reason: 'done',
      state: 'pending',
      stepIndex: 0,
    });
    expect(ctx.checkpointsAtDispatch).toEqual([{ reason: 'done', state: 'pending', stepIndex: 0 }]);
    expect(ctx.stored().metadata[CHECKPOINT]).toEqual({
      reason: 'done',
      state: 'completed',
      stepIndex: 0,
    });
  });

  it('keeps the terminal state when a critical hook fails, then replays only the lifecycle', async () => {
    const ctx = setUp(runningState());
    ctx.dispatchHooks.mockRejectedValueOnce(
      new CriticalHookDeliveryError('bot-reply', new Error('publish failed')),
    );

    await expect(
      ctx.service.executeStep({ context: STEP_CONTEXT, operationId: OPERATION_ID, stepIndex: 0 }),
    ).rejects.toBeInstanceOf(CriticalHookDeliveryError);

    expect(ctx.stored()).toMatchObject({ status: 'done', stepCount: 1 });
    expect(ctx.stored().error).toBeUndefined();
    expect(ctx.stored().metadata[CHECKPOINT]).toEqual({
      reason: 'done',
      state: 'pending',
      stepIndex: 0,
    });
    expect(ctx.coordinator.saveAgentState).not.toHaveBeenCalled();
    expect(ctx.errorEvents()).toHaveLength(0);
    expect(ctx.dispatchHooks).toHaveBeenCalledTimes(1);

    const retry = await ctx.service.executeStep({
      context: STEP_CONTEXT,
      externalRetryCount: 1,
      operationId: OPERATION_ID,
      stepIndex: 0,
    });

    expect(retry).toMatchObject({
      nextStepScheduled: false,
      state: { status: 'done' },
      stepResult: null,
      success: true,
    });
    expect(ctx.dispatchHooks.mock.calls.map(([, , reason]) => reason)).toEqual(['done', 'done']);
    expect(ctx.dispatchHooks).toHaveBeenLastCalledWith(
      OPERATION_ID,
      expect.objectContaining({ status: 'done' }),
      'done',
      expect.objectContaining({ strict: true, assertOwnership: expect.any(Function) }),
    );
    expect(ctx.stored().metadata[CHECKPOINT]).toEqual({
      reason: 'done',
      state: 'completed',
      stepIndex: 0,
    });
    expect(ctx.finalizeTrace).toHaveBeenCalledTimes(1);
    expect(ctx.finalizeTrace).toHaveBeenCalledWith(
      OPERATION_ID,
      expect.objectContaining({ completionReason: 'done' }),
    );
    expect(ctx.runtimeStep).toHaveBeenCalledTimes(1);
    expect(ctx.coordinator.saveStepResult).toHaveBeenCalledTimes(1);
    expect(ctx.hookCalls('beforeStep')).toHaveLength(1);
    expect(ctx.hookCalls('afterStep')).toHaveLength(1);
    expect(
      ctx.streamManager.publishStreamEvent.mock.calls.filter(
        ([, event]: any) => event.type === 'step_start',
      ),
    ).toHaveLength(1);

    const responseLoss = await ctx.service.executeStep({
      context: STEP_CONTEXT,
      externalRetryCount: 2,
      operationId: OPERATION_ID,
      stepIndex: 0,
    });

    expect(responseLoss).toMatchObject({ stepResult: null, success: true });
    expect(ctx.dispatchHooks).toHaveBeenCalledTimes(2);
    expect(ctx.runtimeStep).toHaveBeenCalledTimes(1);
  });

  it('replays for a delivery of an earlier step than the one that finished the run', async () => {
    const ctx = setUp(terminalState('done', { reason: 'done', state: 'pending', stepIndex: 2 }, 3));

    const result = await ctx.service.executeStep({
      context: STEP_CONTEXT,
      externalRetryCount: 1,
      operationId: OPERATION_ID,
      stepIndex: 0,
    });

    expect(result).toMatchObject({ state: { status: 'done' }, success: true });
    expect(ctx.dispatchHooks).toHaveBeenCalledTimes(1);
    expect(ctx.stored().metadata[CHECKPOINT]).toEqual({
      reason: 'done',
      state: 'completed',
      stepIndex: 2,
    });
    expect(ctx.runtimeStep).not.toHaveBeenCalled();
  });

  it('replays the later terminal step of a resume delivery without consuming its payload again', async () => {
    const ctx = setUp(
      { ...runningState(), status: 'waiting_for_human', stepCount: 1 },
      { queueService: queueWith(vi.fn()) },
    );
    ctx.coordinator.saveInlineResume = vi.fn().mockResolvedValue(true);
    const processIntervention = vi
      .spyOn((ctx.service as any).humanIntervention, 'process')
      .mockImplementation(async (state: any) => ({
        newState: { ...state, status: 'running' },
        nextContext: STEP_CONTEXT,
      }));
    ctx.runtimeStep.mockImplementationOnce(async (state: any) => ({
      events: [],
      newState: { ...state, status: 'running', stepCount: state.stepCount + 1 },
      nextContext: STEP_CONTEXT,
    }));
    ctx.dispatchHooks.mockRejectedValueOnce(
      new CriticalHookDeliveryError('bot-reply', new Error('publish failed')),
    );
    const approval = {
      approvedToolCall: { id: 'call-1' } as any,
      context: STEP_CONTEXT,
      operationId: OPERATION_ID,
      stepIndex: 1,
    };
    const inline = { inlineContinuation: true, retainStepLock: true, stepLockOwner: 'owner-1' };

    const approved = await ctx.service.executeStep({ ...approval, ...inline });
    expect(approved.continuation).toMatchObject({ stepIndex: 2 });
    await expect(
      ctx.service.executeStep({
        ...inline,
        context: approved.continuation!.context,
        operationId: OPERATION_ID,
        stepIndex: 2,
      }),
    ).rejects.toBeInstanceOf(CriticalHookDeliveryError);
    expect(ctx.stored()).toMatchObject({ status: 'done', stepCount: 3 });
    expect(ctx.stored().metadata[CHECKPOINT]).toEqual({
      reason: 'done',
      state: 'pending',
      stepIndex: 2,
    });

    vi.spyOn((ctx.service as any).agentOperationModel, 'findById').mockResolvedValue({
      id: OPERATION_ID,
      status: 'done',
    });
    const retry = await ctx.service.executeStep({ ...approval, externalRetryCount: 1 });

    expect(retry).toMatchObject({ state: { status: 'done' }, stepResult: null, success: true });
    expect(processIntervention).toHaveBeenCalledTimes(1);
    expect(ctx.runtimeStep).toHaveBeenCalledTimes(2);
    expect(ctx.dispatchHooks.mock.calls.map(([, , reason]) => reason)).toEqual(['done', 'done']);
    expect(ctx.stored().metadata[CHECKPOINT]).toEqual({
      reason: 'done',
      state: 'completed',
      stepIndex: 2,
    });
  });

  it('does not notify a terminal run that carries no checkpoint', async () => {
    const ctx = setUp(terminalState('done'));

    const result = await ctx.service.executeStep({
      context: STEP_CONTEXT,
      externalRetryCount: 1,
      operationId: OPERATION_ID,
      stepIndex: 0,
    });

    expect(result).toMatchObject({ stepResult: null, success: true });
    expect(ctx.dispatchHooks).not.toHaveBeenCalled();
    expect(ctx.coordinator.saveAgentState).not.toHaveBeenCalled();
  });

  // No checkpoint is owed only while the durable row is still in flight (a Stop
  // between two steps, see executeStep.hatchetRecovery.test.ts); without a row
  // there is nothing to prove the run was never announced.
  it.each([
    ['no checkpoint and no durable row', undefined, null],
    ['a completed checkpoint', { state: 'completed' as const, stepIndex: 0 }, 'running'],
  ])('does not dispatch a terminal lifecycle with %s', async (_label, checkpoint, rowStatus) => {
    const ctx = setUp(terminalState('error', checkpoint, 0));
    vi.spyOn((ctx.service as any).agentOperationModel, 'findById').mockResolvedValue(
      rowStatus ? { id: OPERATION_ID, status: rowStatus } : null,
    );
    await ctx.service.executeStep({ operationId: OPERATION_ID, stepIndex: 0 });
    expect(ctx.dispatchHooks).not.toHaveBeenCalled();
    expect(ctx.emitSignalEvents).not.toHaveBeenCalled();
    expect(ctx.runtimeStep).not.toHaveBeenCalled();
  });

  it('makes a failed step’s own error notification replayable', async () => {
    const ctx = setUp(runningState());
    ctx.runtimeStep.mockRejectedValueOnce(new Error('provider exploded'));
    ctx.dispatchHooks.mockRejectedValueOnce(
      new CriticalHookDeliveryError('bot-reply', new Error('publish failed')),
    );

    await expect(
      ctx.service.executeStep({ context: STEP_CONTEXT, operationId: OPERATION_ID, stepIndex: 0 }),
    ).rejects.toBeInstanceOf(CriticalHookDeliveryError);

    expect(ctx.stored()).toMatchObject({ status: 'error' });
    expect(ctx.stored().metadata[CHECKPOINT]).toEqual({
      reason: 'error',
      state: 'pending',
      stepIndex: 0,
    });

    await ctx.service.executeStep({
      context: STEP_CONTEXT,
      externalRetryCount: 1,
      operationId: OPERATION_ID,
      stepIndex: 0,
    });

    expect(ctx.runtimeStep).toHaveBeenCalledTimes(1);
    expect(ctx.dispatchHooks).toHaveBeenCalledTimes(2);
    expect(ctx.dispatchHooks).toHaveBeenLastCalledWith(
      OPERATION_ID,
      expect.objectContaining({ status: 'error' }),
      'error',
      expect.objectContaining({ strict: true, assertOwnership: expect.any(Function) }),
    );
    expect(ctx.stored().metadata[CHECKPOINT]).toEqual({
      reason: 'error',
      state: 'completed',
      stepIndex: 0,
    });
  });

  it('replays a forced async-tool finish without spending a step', async () => {
    const ctx = setUp({ ...runningState(), status: 'waiting_for_async_tool' });
    vi.spyOn(ctx.service as any, 'refreshMessagesFromDB').mockResolvedValue([]);
    ctx.dispatchHooks.mockRejectedValueOnce(new Error('publish failed'));

    await expect(
      ctx.service.executeStep({
        context: STEP_CONTEXT,
        finishAfterAsyncTool: true,
        operationId: OPERATION_ID,
        stepIndex: 0,
      }),
    ).rejects.toThrow('publish failed');
    expect(ctx.stored()).toMatchObject({ status: 'done', stepCount: 0 });
    expect(ctx.stored().metadata[CHECKPOINT].state).toBe('pending');

    await ctx.service.executeStep({ operationId: OPERATION_ID, stepIndex: 0 });
    expect(ctx.stored().metadata[CHECKPOINT].state).toBe('completed');
    expect(ctx.runtimeStep).not.toHaveBeenCalled();
  });
});

describe('executeStep (Hatchet) - early ACK guards', () => {
  it('lets a durable-terminal delivery through to the lock when the lifecycle is owed', async () => {
    const ctx = setUp(terminalState('done', { reason: 'done', state: 'pending', stepIndex: 0 }));
    vi.spyOn((ctx.service as any).agentOperationModel, 'findById').mockResolvedValue({
      id: OPERATION_ID,
      status: 'done',
    });

    const result = await ctx.service.executeStep({
      externalRetryCount: 1,
      operationId: OPERATION_ID,
      stepIndex: 0,
    });

    expect(result).toMatchObject({ state: { status: 'done' }, success: true });
    expect(ctx.coordinator.tryClaimStep).toHaveBeenCalledTimes(1);
    expect(ctx.dispatchHooks).toHaveBeenCalledTimes(1);
    expect(ctx.stored().metadata[CHECKPOINT]).toEqual({
      reason: 'done',
      state: 'completed',
      stepIndex: 0,
    });
  });

  it.each([
    ['a completed checkpoint', { state: 'completed' as const, stepIndex: 0 }],
    ['no checkpoint', undefined],
  ])('ACKs a durable-terminal delivery with %s without claiming', async (_label, checkpoint) => {
    const ctx = setUp(terminalState('done', checkpoint));
    vi.spyOn((ctx.service as any).agentOperationModel, 'findById').mockResolvedValue({
      id: OPERATION_ID,
      status: 'done',
    });

    const result = await ctx.service.executeStep({
      externalRetryCount: 1,
      operationId: OPERATION_ID,
      stepIndex: 0,
    });

    expect(result).toEqual({
      nextStepScheduled: false,
      state: { status: 'done' },
      stepResult: null,
      success: true,
    });
    expect(ctx.coordinator.tryClaimStep).not.toHaveBeenCalled();
    expect(ctx.dispatchHooks).not.toHaveBeenCalled();
  });

  it.each([
    ['interrupted', 'done', 'interrupted'],
    ['error', 'done', 'error'],
    ['abandoned', 'interrupted', 'interrupted'],
  ])(
    'ACKs an owed lifecycle whose durable row was settled %s elsewhere',
    async (rowStatus, savedStatus, ackedStatus) => {
      const ctx = setUp({
        ...terminalState('done', { reason: 'done', state: 'pending', stepIndex: 0 }),
        status: savedStatus,
      });
      vi.spyOn((ctx.service as any).agentOperationModel, 'findById').mockResolvedValue({
        id: OPERATION_ID,
        status: rowStatus,
      });

      const result = await ctx.service.executeStep({
        externalRetryCount: 1,
        operationId: OPERATION_ID,
        stepIndex: 0,
      });

      expect(result).toEqual({
        nextStepScheduled: false,
        state: { status: ackedStatus },
        stepResult: null,
        success: true,
      });
      expect(ctx.coordinator.tryClaimStep).not.toHaveBeenCalled();
      expect(ctx.dispatchHooks).not.toHaveBeenCalled();
      expect(ctx.emitSignalEvents).not.toHaveBeenCalled();
    },
  );

  it('waits out a held lock for an owed lifecycle, then replays it once', async () => {
    const scheduleMessage = vi.fn().mockResolvedValue('message-1');
    const ctx = setUp(
      terminalState('done', { reason: 'done', state: 'pending', stepIndex: 2 }, 3),
      {
        queueService: queueWith(scheduleMessage),
      },
    );
    const processIntervention = vi.spyOn((ctx.service as any).humanIntervention, 'process');
    ctx.coordinator.tryClaimStep = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    const delivery = {
      approvedToolCall: { id: 'call-1' } as any,
      context: STEP_CONTEXT,
      operationId: OPERATION_ID,
      stepIndex: 1,
    };

    const locked = await ctx.service.executeStep({ ...delivery, externalRetryCount: 1 });

    expect(locked).toMatchObject({ locked: true, lockRescheduled: true });
    expect(scheduleMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: OPERATION_ID,
        payload: expect.objectContaining({
          approvedToolCall: { id: 'call-1' },
          lockRetryAttempt: 1,
        }),
        stepIndex: 1,
      }),
    );
    expect(ctx.dispatchHooks).not.toHaveBeenCalled();

    const requeued = await ctx.service.executeStep({ ...delivery, lockRetryAttempt: 1 });

    expect(requeued).toMatchObject({ state: { status: 'done' }, stepResult: null, success: true });
    expect(ctx.dispatchHooks).toHaveBeenCalledTimes(1);
    expect(ctx.stored().metadata[CHECKPOINT]).toEqual({
      reason: 'done',
      state: 'completed',
      stepIndex: 2,
    });
    expect(processIntervention).not.toHaveBeenCalled();
    expect(ctx.runtimeStep).not.toHaveBeenCalled();
  });

  it('asks for a redelivery of an owed lifecycle when the lock backoff cannot re-queue', async () => {
    const ctx = setUp(terminalState('done', { reason: 'done', state: 'pending', stepIndex: 0 }));
    ctx.coordinator.tryClaimStep = vi.fn().mockResolvedValue(false);

    const result = await ctx.service.executeStep({
      externalRetryCount: 1,
      operationId: OPERATION_ID,
      stepIndex: 0,
    });

    expect(result).toMatchObject({ locked: true, success: false });
    expect(ctx.dispatchHooks).not.toHaveBeenCalled();
  });
});

describe('executeStep (Hatchet) - lock ownership', () => {
  it('logs the claim as one structured line', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const ctx = setUp(terminalState('done'));

    await ctx.service.executeStep({
      externalRetryCount: 2,
      operationId: OPERATION_ID,
      stepIndex: 0,
    });

    const lines = info.mock.calls
      .map(([line]) => line)
      .filter((line) => typeof line === 'string' && line.includes('agent.step.claimed'));
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual({
      at: expect.any(Number),
      event: 'agent.step.claimed',
      externalRetryCount: 2,
      operationId: OPERATION_ID,
      stepIndex: 0,
    });
  });

  it('does not log a claim that lost the race', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const ctx = setUp(runningState());
    ctx.coordinator.tryClaimStep = vi.fn().mockResolvedValue(false);

    await ctx.service.executeStep({ operationId: OPERATION_ID, stepIndex: 0 });

    expect(JSON.stringify(info.mock.calls)).not.toContain('agent.step.claimed');
  });

  it.each([
    ['the pre-commit refresh finds the lock gone', (c: any) => c.mockResolvedValue(false)],
    ['the pre-commit refresh fails', (c: any) => c.mockRejectedValue(new Error('redis down'))],
  ])('does not commit when %s', async (_label, arrange) => {
    const ctx = setUp(runningState());
    ctx.coordinator.refreshStepLock = vi.fn();
    arrange(ctx.coordinator.refreshStepLock);

    await expect(
      ctx.service.executeStep({ context: STEP_CONTEXT, operationId: OPERATION_ID, stepIndex: 0 }),
    ).rejects.toBeInstanceOf(StepOwnershipLostError);

    expect(ctx.runtimeStep).toHaveBeenCalledTimes(1);
    expect(ctx.coordinator.saveStepResult).not.toHaveBeenCalled();
    expect(ctx.coordinator.saveAgentState).not.toHaveBeenCalled();
    expect(ctx.dispatchHooks).not.toHaveBeenCalled();
    expect(ctx.errorEvents()).toHaveLength(0);
    expect(ctx.stored()).toMatchObject({ status: 'running', stepCount: 0 });
  });

  it('does not restart trace uploads or save tracking after afterStep loses ownership', async () => {
    const ctx = setUp(runningState(), { queueService: queueWith(vi.fn()) });
    const heartbeat = holdHeartbeat(ctx);
    const append = vi.spyOn((ctx.service as any).traceRecorder, 'appendStep');
    ctx.runtimeStep.mockImplementationOnce(async (state) => ({
      events: [],
      nextContext: STEP_CONTEXT,
      newState: {
        ...state,
        host: { hooks: [{ type: 'afterStep', id: 'held-hook' }] },
        status: 'running',
        stepCount: 1,
      },
    }));
    vi.mocked(hookDispatcher.dispatch).mockImplementation(async (_id, type) => {
      if (type === 'afterStep') heartbeat.loseLock();
    });
    await expect(
      ctx.service.executeStep({
        context: STEP_CONTEXT,
        operationId: OPERATION_ID,
        stepIndex: 0,
        inlineContinuation: true,
      }),
    ).rejects.toBeInstanceOf(StepOwnershipLostError);
    expect(ctx.committed).toHaveLength(1);
    expect(ctx.coordinator.saveAgentState).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
    expect(ctx.dispatchHooks).not.toHaveBeenCalled();
    expect(ctx.errorEvents()).toHaveLength(0);
  });

  // The heartbeat reports only a lock found taken (see the heartbeat test below).
  it('does not commit once the heartbeat found the lock taken, even if a later refresh succeeds', async () => {
    const ctx = setUp(runningState());
    vi.spyOn(ctx.service as any, 'startStepLockHeartbeat').mockImplementation((...args: any[]) => {
      args[3]?.();
      return () => {};
    });

    await expect(
      ctx.service.executeStep({ context: STEP_CONTEXT, operationId: OPERATION_ID, stepIndex: 0 }),
    ).rejects.toBeInstanceOf(StepOwnershipLostError);

    expect(ctx.coordinator.saveStepResult).not.toHaveBeenCalled();
    expect(ctx.stored()).toMatchObject({ status: 'running', stepCount: 0 });
  });

  it.each([
    [
      'the heartbeat lost the lock',
      (ctx: ReturnType<typeof setUp>) => {
        const heartbeat = holdHeartbeat(ctx);
        ctx.runtimeStep.mockImplementationOnce(async () => {
          heartbeat.loseLock();
          throw new Error('tool failed');
        });
      },
    ],
    [
      'another attempt holds the lock now',
      (ctx: ReturnType<typeof setUp>) => {
        ctx.coordinator.refreshStepLock = vi.fn().mockResolvedValue(false);
      },
    ],
  ])('settles nothing when %s and a tool then throws an ordinary error', async (_label, lose) => {
    const ctx = setUp(runningState());
    lose(ctx);
    ctx.runtimeStep.mockRejectedValueOnce(new Error('tool failed'));

    await expect(
      ctx.service.executeStep({ context: STEP_CONTEXT, operationId: OPERATION_ID, stepIndex: 0 }),
    ).rejects.toBeInstanceOf(StepOwnershipLostError);

    expect(ctx.coordinator.saveAgentState).not.toHaveBeenCalled();
    expect(ctx.coordinator.saveStepResult).not.toHaveBeenCalled();
    expect(ctx.errorEvents()).toHaveLength(0);
    expect(ctx.emitSignalEvents).not.toHaveBeenCalled();
    expect(ctx.dispatchHooks).not.toHaveBeenCalled();
    expect(ctx.finalizeTrace).not.toHaveBeenCalled();
    expect(ctx.stored()).toMatchObject({ status: 'running', stepCount: 0 });
  });

  it.each([
    ['a finished step', () => runningState(), 0],
    [
      'a replayed lifecycle',
      () => terminalState('done', { reason: 'done', state: 'pending', stepIndex: 0 }),
      1,
    ],
  ])(
    'leaves the lifecycle owed when the lock goes while the hooks of %s are out',
    async (_label, initialState, externalRetryCount) => {
      const ctx = setUp(initialState());
      const heartbeat = holdHeartbeat(ctx);
      ctx.dispatchHooks.mockImplementationOnce(async () => heartbeat.loseLock());

      await expect(
        ctx.service.executeStep({
          context: STEP_CONTEXT,
          externalRetryCount,
          operationId: OPERATION_ID,
          stepIndex: 0,
        }),
      ).rejects.toBeInstanceOf(StepOwnershipLostError);

      expect(ctx.dispatchHooks).toHaveBeenCalledTimes(1);
      expect(ctx.coordinator.saveAgentState).not.toHaveBeenCalled();
      expect(ctx.stored()).toMatchObject({ status: 'done' });
      expect(ctx.stored().metadata[CHECKPOINT]).toEqual({
        reason: 'done',
        state: 'pending',
        stepIndex: 0,
      });
    },
  );

  it('leaves a failed step’s error lifecycle owed when the lock goes while its hooks are out', async () => {
    const ctx = setUp(runningState());
    const heartbeat = holdHeartbeat(ctx);
    ctx.runtimeStep.mockRejectedValueOnce(new Error('provider exploded'));
    ctx.dispatchHooks.mockImplementationOnce(async () => heartbeat.loseLock());

    await expect(
      ctx.service.executeStep({ context: STEP_CONTEXT, operationId: OPERATION_ID, stepIndex: 0 }),
    ).rejects.toBeInstanceOf(StepOwnershipLostError);

    expect(ctx.coordinator.saveAgentState).toHaveBeenCalledTimes(1);
    expect(ctx.stored()).toMatchObject({ status: 'error' });
    expect(ctx.stored().metadata[CHECKPOINT]).toEqual({
      reason: 'error',
      state: 'pending',
      stepIndex: 0,
    });
  });

  it.each([
    [
      'a step that parks for approval',
      () => runningState(),
      0,
      (ctx: ReturnType<typeof setUp>) =>
        ctx.runtimeStep.mockImplementationOnce(async (state: any) => ({
          events: [],
          newState: { ...state, status: 'waiting_for_human', stepCount: state.stepCount + 1 },
          nextContext: undefined,
        })),
    ],
    [
      'a replayed approval lifecycle',
      () => ({
        ...runningState(),
        metadata: {
          _agentInterventionLifecycle: { reason: 'done', state: 'pending', stepIndex: 0 },
        },
        pendingApprovalBatch: { sealed: true },
        status: 'waiting_for_human',
        stepCount: 1,
      }),
      1,
      () => {},
    ],
  ])(
    'does not record the approval checkpoint of %s once the lock is gone',
    async (_label, initialState, externalRetryCount, arrange) => {
      const ctx = setUp(initialState());
      const heartbeat = holdHeartbeat(ctx);
      arrange(ctx);
      ctx.dispatchHooks.mockImplementationOnce(async () => heartbeat.loseLock());
      const recordIntervention = vi.spyOn(
        ctx.service as any,
        'recordInterventionLifecycleCompletion',
      );

      await expect(
        ctx.service.executeStep({
          context: STEP_CONTEXT,
          externalRetryCount,
          operationId: OPERATION_ID,
          stepIndex: 0,
        }),
      ).rejects.toBeInstanceOf(StepOwnershipLostError);

      expect(ctx.dispatchHooks).toHaveBeenCalledWith(
        OPERATION_ID,
        expect.objectContaining({ status: 'waiting_for_human' }),
        'waiting_for_human',
        expect.objectContaining({ assertOwnership: expect.any(Function) }),
      );
      expect(recordIntervention).not.toHaveBeenCalled();
      expect(ctx.coordinator.saveAgentState).not.toHaveBeenCalled();
    },
  );

  // An unreachable lock is not a lost one: owners are random, so the refresh
  // before the commit still tells (and refuses to commit while Redis is down).
  it('reports a lock found taken from the heartbeat, not an unreachable one or a lease failure', async () => {
    vi.useFakeTimers();
    const service = new AgentRuntimeService({} as any, 'user-1', { queueService: null });
    const coordinator = (service as any).coordinator;
    coordinator.refreshStepLock = vi
      .fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
      .mockRejectedValueOnce(new StepLockUnavailableError('op-heartbeat'));
    vi.spyOn((service as any).agentOperationModel, 'touchRunning').mockRejectedValue(
      new Error('db down'),
    );
    const onOwnershipLost = vi.fn();

    try {
      const stop = (service as any).startStepLockHeartbeat('op-heartbeat', 7, 'owner-1', () =>
        onOwnershipLost(),
      );
      await vi.advanceTimersByTimeAsync(30_000);
      expect(onOwnershipLost).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(onOwnershipLost).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(onOwnershipLost).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(coordinator.refreshStepLock).toHaveBeenCalledTimes(4);
      expect(onOwnershipLost).toHaveBeenCalledTimes(1);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('executeStep outside Hatchet', () => {
  it('keeps the historical error path when a critical hook fails', async () => {
    hatchet.enabled = false;
    const ctx = setUp(runningState());
    ctx.dispatchHooks.mockRejectedValueOnce(
      new CriticalHookDeliveryError('bot-reply', new Error('publish failed')),
    );

    await expect(
      ctx.service.executeStep({ context: STEP_CONTEXT, operationId: OPERATION_ID, stepIndex: 0 }),
    ).rejects.toBeInstanceOf(CriticalHookDeliveryError);

    expect(ctx.committed[0].metadata?.[CHECKPOINT]).toBeUndefined();
    expect(ctx.stored().status).toBe('error');
    expect(ctx.stored().metadata?.[CHECKPOINT]).toBeUndefined();
    expect(ctx.dispatchHooks.mock.calls.map(([, , reason]) => reason)).toEqual(['done', 'error']);

    await ctx.service.executeStep({
      context: STEP_CONTEXT,
      externalRetryCount: 1,
      operationId: OPERATION_ID,
      stepIndex: 0,
    });
    expect(ctx.dispatchHooks).toHaveBeenCalledTimes(2);
  });

  it('fails a step the historical way even when the lock looks lost', async () => {
    hatchet.enabled = false;
    const ctx = setUp(runningState());
    ctx.coordinator.refreshStepLock = vi.fn().mockResolvedValue(false);
    ctx.runtimeStep.mockRejectedValueOnce(new Error('tool failed'));

    await expect(
      ctx.service.executeStep({ context: STEP_CONTEXT, operationId: OPERATION_ID, stepIndex: 0 }),
    ).rejects.toThrow('tool failed');

    expect(ctx.coordinator.refreshStepLock).not.toHaveBeenCalled();
    expect(ctx.stored()).toMatchObject({ status: 'error' });
    expect(ctx.stored().metadata?.[CHECKPOINT]).toBeUndefined();
    expect(ctx.dispatchHooks).toHaveBeenCalledWith(
      OPERATION_ID,
      expect.objectContaining({ status: 'error' }),
      'error',
    );
  });

  it('ACKs a durable-terminal delivery without reading the state', async () => {
    hatchet.enabled = false;
    const ctx = setUp(terminalState('done', { reason: 'done', state: 'pending', stepIndex: 0 }));
    vi.spyOn((ctx.service as any).agentOperationModel, 'findById').mockResolvedValue({
      id: OPERATION_ID,
      status: 'done',
    });

    await ctx.service.executeStep({
      externalRetryCount: 1,
      operationId: OPERATION_ID,
      stepIndex: 0,
    });

    expect(ctx.coordinator.loadAgentState).not.toHaveBeenCalled();
    expect(ctx.coordinator.tryClaimStep).not.toHaveBeenCalled();
  });

  it('ACKs a stale duplicate behind a held lock, owed lifecycle or not', async () => {
    hatchet.enabled = false;
    const scheduleMessage = vi.fn();
    const ctx = setUp(terminalState('done', { reason: 'done', state: 'pending', stepIndex: 0 }), {
      queueService: { getImpl: () => ({}), scheduleMessage },
    });
    ctx.coordinator.tryClaimStep = vi.fn().mockResolvedValue(false);

    const result = await ctx.service.executeStep({
      externalRetryCount: 1,
      operationId: OPERATION_ID,
      stepIndex: 0,
    });

    expect(result).toMatchObject({ stepResult: null, success: true });
    expect(scheduleMessage).not.toHaveBeenCalled();
  });

  it('commits without a pre-commit lock check and logs no claim', async () => {
    hatchet.enabled = false;
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const ctx = setUp(runningState());
    ctx.coordinator.refreshStepLock = vi.fn().mockResolvedValue(false);

    const result = await ctx.service.executeStep({
      context: STEP_CONTEXT,
      operationId: OPERATION_ID,
      stepIndex: 0,
    });

    expect(result.success).toBe(true);
    expect(ctx.coordinator.saveStepResult).toHaveBeenCalledTimes(1);
    expect(ctx.coordinator.refreshStepLock).not.toHaveBeenCalled();
    expect(JSON.stringify(info.mock.calls)).not.toContain('agent.step.claimed');
  });
});

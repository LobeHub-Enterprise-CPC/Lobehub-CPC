/**
 * Shared harness for the Hatchet `executeStep` scenario tests
 * (`executeStep.hatchet*.test.ts`). Each test file keeps its own `vi.mock`
 * calls (Vitest hoists them per file); this module only builds the service
 * and the fixtures on top of those mocks.
 */
import type { ISnapshotStore } from '@lobechat/agent-tracing';
import { vi } from 'vitest';

import { AgentRuntimeService } from '../AgentRuntimeService';
import { hookDispatcher } from '../hooks';

export const OPERATION_ID = 'op-hatchet';
export const CHECKPOINT = '_completionLifecycle';
export const STEP_CONTEXT = { phase: 'user_input' } as any;

export const runningState = () => ({
  cost: { currency: 'USD', total: 0 },
  host: { hooks: [] },
  lastModified: new Date().toISOString(),
  messages: [],
  metadata: {},
  operationId: OPERATION_ID,
  status: 'running',
  stepCount: 0,
  toolManifestMap: {},
  usage: {},
});

export const terminalState = (
  status: 'done' | 'error',
  checkpoint?: { reason?: string; state: 'completed' | 'pending'; stepIndex: number },
  stepCount = 1,
) => ({
  ...runningState(),
  metadata: checkpoint ? { [CHECKPOINT]: { ...checkpoint, reason: status } } : {},
  status,
  stepCount,
});

/**
 * A service whose coordinator stores the state the way Redis does: every
 * load and save is a copy, so only what was saved survives a delivery.
 */
export const setUp = (
  initialState: object | null,
  options: { queueService?: any; snapshotStore?: ISnapshotStore } = {},
) => {
  const service = new AgentRuntimeService({} as any, 'user-1', {
    queueService: options.queueService ?? null,
    snapshotStore: options.snapshotStore,
  });
  const coordinator = (service as any).coordinator;
  const completionLifecycle = (service as any).completionLifecycle;
  const streamManager = (service as any).streamManager;
  vi.spyOn((service as any).agentOperationModel, 'findById').mockResolvedValue(null);

  let stored: any = initialState ? structuredClone(initialState) : null;
  const committed: any[] = [];
  coordinator.loadAgentState = vi.fn(async () => (stored ? structuredClone(stored) : null));
  coordinator.saveStepResult = vi.fn(async (_operationId: string, result: any) => {
    stored = structuredClone(result.newState);
    committed.push(structuredClone(result.newState));
  });
  coordinator.saveAgentState = vi.fn(async (_operationId: string, state: any) => {
    stored = structuredClone(state);
  });
  streamManager.publishStreamEvent = vi.fn().mockResolvedValue(undefined);

  // What a completion dispatch saw of the stored checkpoint when it started.
  const checkpointsAtDispatch: unknown[] = [];
  const dispatchHooks = vi
    .spyOn(completionLifecycle, 'dispatchHooks')
    .mockImplementation(async () => {
      checkpointsAtDispatch.push(stored?.metadata?.[CHECKPOINT]);
    });
  const emitSignalEvents = vi.spyOn(completionLifecycle, 'emitSignalEvents').mockResolvedValue([]);
  vi.spyOn(completionLifecycle, 'registerFileWorks').mockResolvedValue(undefined);
  const hookDispatch = vi.spyOn(hookDispatcher, 'dispatch').mockResolvedValue(undefined as any);
  const finalizeTrace = vi.spyOn((service as any).traceRecorder, 'finalize');

  const runtimeStep = vi.fn(async (state: any) => ({
    events: [],
    newState: { ...state, status: 'done', stepCount: state.stepCount + 1 },
    nextContext: undefined,
  }));
  vi.spyOn(service as any, 'createAgentRuntime').mockResolvedValue({
    runtime: { step: runtimeStep },
  });

  const errorEvents = () =>
    streamManager.publishStreamEvent.mock.calls.filter(([, event]: any) => event.type === 'error');
  const hookCalls = (type: string) =>
    hookDispatch.mock.calls.filter(([, hookType]) => hookType === type);

  return {
    checkpointsAtDispatch,
    committed,
    coordinator,
    dispatchHooks,
    emitSignalEvents,
    errorEvents,
    finalizeTrace,
    hookCalls,
    runtimeStep,
    service,
    stored: () => stored,
    streamManager,
  };
};

/** Hands the test the heartbeat's "lock lost" callback instead of running timers. */
export const holdHeartbeat = (ctx: ReturnType<typeof setUp>) => {
  const heartbeat = { loseLock: () => {} };
  vi.spyOn(ctx.service as any, 'startStepLockHeartbeat').mockImplementation((...args: any[]) => {
    heartbeat.loseLock = args[3] ?? (() => {});
    return () => {};
  });
  return heartbeat;
};

export const queueWith = (scheduleMessage: ReturnType<typeof vi.fn>) => ({
  getImpl: () => ({}),
  scheduleMessage,
});

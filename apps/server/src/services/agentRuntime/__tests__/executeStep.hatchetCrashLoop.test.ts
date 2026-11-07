// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

import type * as HatchetConfig from '@/server/modules/Hatchet/config';

import { MAX_CRASHED_STEP_ATTEMPTS } from '../AgentRuntimeService/constants';
import { OPERATION_ID, runningState, setUp, STEP_CONTEXT } from './testUtils';

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

/**
 * Hatchet hands a task to another worker when the one running it dies (an OOM
 * kill), without counting a retry. A step that kills every worker it lands on
 * would loop forever, repeating its paid LLM call and taking the other steps
 * on that worker down with it each time.
 */
describe('executeStep (Hatchet) - a step that keeps crashing its worker', () => {
  /** The coordinator's attempt counter, the way Redis keeps it across processes. */
  const countAttempts = (ctx: ReturnType<typeof setUp>, crashedBefore: number) => {
    const unfinished = new Map<string, number>([[`${OPERATION_ID}:0`, crashedBefore]]);
    ctx.coordinator.beginStepAttempt = vi.fn(async (operationId: string, stepIndex: number) => {
      const key = `${operationId}:${stepIndex}`;
      const earlier = unfinished.get(key) ?? 0;
      unfinished.set(key, earlier + 1);
      return earlier;
    });
    ctx.coordinator.endStepAttempt = vi.fn(async (operationId: string, stepIndex: number) => {
      unfinished.delete(`${operationId}:${stepIndex}`);
    });
    return { unfinished: () => unfinished.get(`${OPERATION_ID}:0`) };
  };

  const run = (ctx: ReturnType<typeof setUp>) =>
    ctx.service.executeStep({ context: STEP_CONTEXT, operationId: OPERATION_ID, stepIndex: 0 });

  it('fails the run instead of running the step again once it crashed too often', async () => {
    const ctx = setUp(runningState());
    const attempts = countAttempts(ctx, MAX_CRASHED_STEP_ATTEMPTS);

    await expect(run(ctx)).rejects.toThrow(/crashed/);

    expect(ctx.runtimeStep).not.toHaveBeenCalled();
    expect(ctx.stored().status).toBe('error');
    expect(ctx.dispatchHooks.mock.calls.map(([, , reason]) => reason)).toEqual(['error']);
    expect(attempts.unfinished()).toBeUndefined();
  });

  it('still runs a step that crashed fewer times, and clears the count once it ends', async () => {
    const ctx = setUp(runningState());
    const attempts = countAttempts(ctx, MAX_CRASHED_STEP_ATTEMPTS - 1);

    await run(ctx);

    expect(ctx.runtimeStep).toHaveBeenCalledTimes(1);
    expect(ctx.stored().status).toBe('done');
    expect(attempts.unfinished()).toBeUndefined();
  });

  it('does not count a step that failed without crashing', async () => {
    const ctx = setUp(runningState());
    const attempts = countAttempts(ctx, 0);
    ctx.runtimeStep.mockRejectedValueOnce(new Error('provider down'));

    await expect(run(ctx)).rejects.toThrow('provider down');

    expect(attempts.unfinished()).toBeUndefined();
  });

  it('runs the step when the count cannot be read', async () => {
    const ctx = setUp(runningState());
    ctx.coordinator.beginStepAttempt = vi.fn().mockRejectedValue(new Error('redis down'));
    ctx.coordinator.endStepAttempt = vi.fn().mockResolvedValue(undefined);

    await run(ctx);

    expect(ctx.runtimeStep).toHaveBeenCalledTimes(1);
  });

  it('counts nothing off Hatchet, where the queue counts its redeliveries', async () => {
    hatchet.enabled = false;
    const ctx = setUp(runningState());
    countAttempts(ctx, MAX_CRASHED_STEP_ATTEMPTS);

    await run(ctx);

    expect(ctx.coordinator.beginStepAttempt).not.toHaveBeenCalled();
    expect(ctx.runtimeStep).toHaveBeenCalledTimes(1);
  });
});

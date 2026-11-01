// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

import type * as HatchetConfig from '@/server/modules/Hatchet/config';

import { StepLockUnavailableError, StepOwnershipLostError } from '../executionErrors';
import { failStep } from './failure';

const hatchet = vi.hoisted(() => ({ enabled: true }));
vi.mock('@/server/modules/Hatchet/config', async (importOriginal) => ({
  ...(await importOriginal<typeof HatchetConfig>()),
  isHatchetDeliveryEnabled: () => hatchet.enabled,
}));
const OPERATION_ID = 'op-hatchet';
const runningState = () => ({ status: 'running' });
const terminalState = (status: string, checkpoint: object, stepCount: number) => ({
  status,
  stepCount,
  metadata: { _completionLifecycle: { ...checkpoint, reason: status } },
});
afterEach(() => {
  hatchet.enabled = true;
  vi.restoreAllMocks();
});

describe('failStep', () => {
  const span = () => ({ recordException: vi.fn(), setAttributes: vi.fn(), setStatus: vi.fn() });
  const failDeps = (state: unknown) => ({
    completionLifecycle: {
      dispatchHooks: vi.fn(),
      emitSignalEvents: vi.fn().mockResolvedValue([]),
      extractErrorMessage: vi.fn(),
    },
    coordinator: {
      loadAgentState: vi.fn().mockResolvedValue(state),
      saveAgentState: vi.fn(),
    },
    streamManager: { publishStreamEvent: vi.fn() },
    traceRecorder: { discardPartial: vi.fn(), finalize: vi.fn() },
  });
  const fail = (deps: ReturnType<typeof failDeps>, error: unknown) =>
    failStep(deps as any, {
      error,
      externalRetryCount: 0,
      invokeAgentSpan: span() as any,
      operationId: OPERATION_ID,
      stepIndex: 1,
      stepStartAt: Date.now(),
    });

  it.each([
    ['lost ownership', new StepOwnershipLostError(OPERATION_ID, 1)],
    ['an unavailable lock', new StepLockUnavailableError(OPERATION_ID)],
  ])('rethrows %s without settling the operation', async (_label, error) => {
    const deps = failDeps(runningState());

    await expect(fail(deps, error)).rejects.toBe(error);

    expect(deps.coordinator.saveAgentState).not.toHaveBeenCalled();
    expect(deps.completionLifecycle.dispatchHooks).not.toHaveBeenCalled();
    expect(deps.streamManager.publishStreamEvent).not.toHaveBeenCalled();
    expect(deps.traceRecorder.finalize).not.toHaveBeenCalled();
  });

  it('leaves a committed terminal state alone when something fails after the commit', async () => {
    const deps = failDeps(terminalState('done', { state: 'pending', stepIndex: 1 }, 2));
    const error = new Error('stream publish failed');

    await expect(fail(deps, error)).rejects.toBe(error);

    expect(deps.coordinator.saveAgentState).not.toHaveBeenCalled();
    expect(deps.completionLifecycle.dispatchHooks).not.toHaveBeenCalled();
    expect(deps.streamManager.publishStreamEvent).not.toHaveBeenCalled();
  });

  // A client takes the `error` event as the run's end. On Hatchet a failed load,
  // ownership check or save retries the delivery and the run goes on, so the
  // event waits for the error state; it still precedes the end of the stream,
  // after which clients read nothing.
  describe('the error event', () => {
    const errorEvents = (deps: ReturnType<typeof failDeps>) =>
      deps.streamManager.publishStreamEvent.mock.calls.filter(([, e]: any) => e.type === 'error');

    it.each([
      [
        'the state cannot be read',
        (deps: ReturnType<typeof failDeps>) => {
          deps.coordinator.loadAgentState
            .mockResolvedValueOnce(runningState())
            .mockRejectedValueOnce(new Error('redis down'));
        },
      ],
      [
        'the error state cannot be saved',
        (deps: ReturnType<typeof failDeps>) => {
          deps.coordinator.saveAgentState.mockRejectedValueOnce(new Error('redis down'));
        },
      ],
    ])('is not published on Hatchet when %s', async (_label, breakIt) => {
      const deps = failDeps(runningState());
      breakIt(deps);

      await expect(fail(deps, new Error('tool failed'))).rejects.toThrow('redis down');

      expect(errorEvents(deps)).toHaveLength(0);
      expect(deps.completionLifecycle.dispatchHooks).not.toHaveBeenCalled();
    });

    it('goes out on Hatchet once the error state is written, ahead of the end of the stream', async () => {
      const order: string[] = [];
      const deps = failDeps(runningState());
      deps.coordinator.saveAgentState.mockImplementation(
        async (
          _id: string,
          _state: unknown,
          _assert: unknown,
          afterWrite?: () => Promise<void>,
        ) => {
          order.push('state written');
          await afterWrite?.();
          order.push('stream ended');
        },
      );
      deps.streamManager.publishStreamEvent.mockImplementation(async () => {
        order.push('error event');
      });

      await expect(fail(deps, new Error('tool failed'))).rejects.toThrow('tool failed');

      // The second write only settles the lifecycle checkpoint.
      expect(order.slice(0, 3)).toEqual(['state written', 'error event', 'stream ended']);
      expect(errorEvents(deps)).toHaveLength(1);
      expect(errorEvents(deps)[0][1]).toMatchObject({
        data: { error: 'tool failed', phase: 'step_execution', stepIndex: 1 },
        stepIndex: 1,
        type: 'error',
      });
    });

    it('still goes out first outside Hatchet, even when nothing can be saved', async () => {
      hatchet.enabled = false;
      const deps = failDeps(runningState());
      deps.coordinator.loadAgentState.mockRejectedValue(new Error('redis down'));
      deps.coordinator.saveAgentState.mockRejectedValue(new Error('redis down'));

      await expect(fail(deps, new Error('tool failed'))).rejects.toThrow('tool failed');

      expect(errorEvents(deps)).toHaveLength(1);
      expect(deps.streamManager.publishStreamEvent.mock.invocationCallOrder[0]).toBeLessThan(
        deps.coordinator.loadAgentState.mock.invocationCallOrder[0],
      );
      expect(deps.coordinator.saveAgentState).toHaveBeenCalledWith(
        OPERATION_ID,
        expect.objectContaining({ status: 'error' }),
        undefined,
      );
    });
  });

  it('leaves a Stop that is not announced yet alone when the delivery fails', async () => {
    const deps = failDeps({ status: 'interrupted', stepCount: 1 });
    const error = new Error('db down');

    await expect(fail(deps, error)).rejects.toBe(error);

    expect(deps.coordinator.saveAgentState).not.toHaveBeenCalled();
    expect(deps.completionLifecycle.dispatchHooks).not.toHaveBeenCalled();
    expect(deps.streamManager.publishStreamEvent).not.toHaveBeenCalled();
  });

  it('settles the same committed terminal state as an error outside Hatchet', async () => {
    hatchet.enabled = false;
    const deps = failDeps(terminalState('done', { state: 'pending', stepIndex: 1 }, 2));
    const error = new Error('stream publish failed');

    await expect(fail(deps, error)).rejects.toBe(error);

    expect(deps.coordinator.saveAgentState).toHaveBeenCalledWith(
      OPERATION_ID,
      expect.objectContaining({ status: 'error' }),
      undefined,
    );
    expect(deps.completionLifecycle.dispatchHooks).toHaveBeenCalledWith(
      OPERATION_ID,
      expect.objectContaining({ status: 'error' }),
      'error',
    );
  });
});

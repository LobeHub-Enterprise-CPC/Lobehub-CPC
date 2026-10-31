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

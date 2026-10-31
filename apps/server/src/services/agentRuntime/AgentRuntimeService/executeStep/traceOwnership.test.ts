import { describe, expect, it, vi } from 'vitest';

import type * as HatchetConfig from '@/server/modules/Hatchet/config';

import { StepOwnershipLostError } from '../executionErrors';
import { finishOperation } from './completion';
import { failStep } from './failure';

vi.mock('@/server/modules/Hatchet/config', async (importOriginal) => ({
  ...(await importOriginal<typeof HatchetConfig>()),
  isHatchetDeliveryEnabled: () => true,
}));

const operationId = 'op-trace-ownership';
const span = () => ({ recordException: vi.fn(), setAttributes: vi.fn(), setStatus: vi.fn() });

describe('trace ownership at completion', () => {
  it('does not finalize a parked parent after its self-check hands execution over', async () => {
    let lost = false;
    const finalize = vi.fn();
    const ownershipError = new StepOwnershipLostError(operationId, 1);
    const deps = {
      completionLifecycle: {
        dispatchHooks: vi.fn(),
        emitSignalEvents: vi.fn().mockResolvedValue([]),
      },
      determineCompletionReason: () => 'waiting_for_async_tool',
      traceRecorder: { finalize },
      tryResumeParentFromAsyncTool: vi.fn(async () => {
        lost = true;
      }),
    };

    await expect(
      finishOperation(deps as any, {
        assertOwnership: async () => {
          if (lost) throw ownershipError;
        },
        invokeAgentSpan: span() as any,
        operationId,
        stepIndex: 1,
        stepResult: { newState: { status: 'waiting_for_async_tool' } } as any,
      }),
    ).rejects.toBe(ownershipError);

    expect(finalize).not.toHaveBeenCalled();
  });

  it('does not finalize an error after losing ownership during its checkpoint write', async () => {
    let lost = false;
    let writes = 0;
    const finalize = vi.fn();
    const ownershipError = new StepOwnershipLostError(operationId, 1);
    const deps = {
      completionLifecycle: {
        dispatchHooks: vi.fn(),
        emitSignalEvents: vi.fn().mockResolvedValue([]),
        extractErrorMessage: () => 'tool failed',
      },
      coordinator: {
        loadAgentState: vi.fn().mockResolvedValue({ status: 'running', metadata: {} }),
        saveAgentState: vi.fn(async () => {
          if (++writes === 2) lost = true;
        }),
      },
      streamManager: { publishStreamEvent: vi.fn() },
      traceRecorder: { finalize },
    };

    await expect(
      failStep(deps as any, {
        assertOwnership: async () => {
          if (lost) throw ownershipError;
        },
        error: new Error('tool failed'),
        externalRetryCount: 0,
        invokeAgentSpan: span() as any,
        operationId,
        stepIndex: 1,
        stepStartAt: 0,
      }),
    ).rejects.toBe(ownershipError);

    expect(finalize).not.toHaveBeenCalled();
  });
});

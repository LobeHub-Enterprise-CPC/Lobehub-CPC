import { describe, expect, it, vi } from 'vitest';

import type * as HatchetConfig from '@/server/modules/Hatchet/config';

import { OperationTraceRecorder } from '../../OperationTraceRecorder';
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
      traceRecorder: { finalize, flushPartial: vi.fn() },
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

  it('keeps the complete trajectory when an async-tool parent resumes in another invocation', async () => {
    let partial: any = null;
    let snapshot: any;
    const store = {
      loadPartial: vi.fn(async () => structuredClone(partial)),
      removePartial: vi.fn(async () => {
        partial = null;
      }),
      save: vi.fn(async (value) => {
        snapshot = structuredClone(value);
      }),
      savePartial: vi.fn(async (_id, value) => {
        partial = structuredClone(value);
      }),
    };
    const append = (recorder: OperationTraceRecorder, stepIndex: number) =>
      recorder.appendStep(operationId, {
        afterStepSignalEvents: [],
        agentState: { messages: [] },
        beforeStepSignalEvents: [],
        externalRetryCount: 0,
        presentation: { executionTimeMs: 1, stepType: 'call_tool', thinking: false } as any,
        startedAt: 0,
        stepIndex,
        stepResult: { events: [], newState: { messages: [] } },
      });
    const parkedRecorder = new OperationTraceRecorder(store as any);
    await append(parkedRecorder, 0);
    await append(parkedRecorder, 1);

    await finishOperation(
      {
        completionLifecycle: {
          dispatchHooks: vi.fn(),
          emitSignalEvents: vi.fn().mockResolvedValue([]),
        },
        determineCompletionReason: () => 'waiting_for_async_tool',
        traceRecorder: parkedRecorder,
        tryResumeParentFromAsyncTool: vi.fn(),
      } as any,
      {
        assertOwnership: async () => {},
        invokeAgentSpan: span() as any,
        operationId,
        stepIndex: 1,
        stepResult: { newState: { status: 'waiting_for_async_tool' } } as any,
      },
    );

    const resumedRecorder = new OperationTraceRecorder(store as any);
    await append(resumedRecorder, 2);
    await append(resumedRecorder, 3);
    await resumedRecorder.finalize(operationId, { completionReason: 'done', state: {} });

    expect(snapshot.steps.map((step: any) => step.stepIndex)).toEqual([0, 1, 2, 3]);
    expect(snapshot.totalSteps).toBe(4);
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

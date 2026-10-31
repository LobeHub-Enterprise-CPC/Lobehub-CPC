import type { ExecutionSnapshot, ISnapshotStore } from '@lobechat/agent-tracing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type AppendStepParams, OperationTraceRecorder } from './OperationTraceRecorder';

const OPERATION_ID = 'op_1';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

const stepParams = (stepIndex: number): AppendStepParams => ({
  afterStepSignalEvents: [],
  agentState: { messages: [] },
  beforeStepSignalEvents: [],
  externalRetryCount: 0,
  presentation: { executionTimeMs: 1, stepType: 'call_llm', thinking: false } as any,
  startedAt: 0,
  stepIndex,
  stepResult: { events: [], newState: { messages: [] } },
});

const createStore = () => {
  const store = {
    loadPartial: vi.fn<(operationId: string) => Promise<Partial<ExecutionSnapshot> | null>>(
      async () => null,
    ),
    removePartial: vi.fn<(operationId: string) => Promise<void>>(async () => {}),
    save: vi.fn<(snapshot: ExecutionSnapshot) => Promise<void>>(async () => {}),
    savePartial: vi.fn<
      (
        operationId: string,
        partial: Partial<ExecutionSnapshot>,
        options?: { signal?: AbortSignal },
      ) => Promise<void>
    >(async () => {}),
  };
  return store as typeof store & ISnapshotStore;
};

describe('OperationTraceRecorder partial accumulation', () => {
  let store: ReturnType<typeof createStore>;
  let recorder: OperationTraceRecorder;

  beforeEach(() => {
    store = createStore();
    recorder = new OperationTraceRecorder(store);
  });

  it('reads the stored partial once for a run of steps', async () => {
    await recorder.appendStep(OPERATION_ID, stepParams(0));
    await recorder.appendStep(OPERATION_ID, stepParams(1));
    await recorder.appendStep(OPERATION_ID, stepParams(2));
    await recorder.flushPartial();

    expect(store.loadPartial).toHaveBeenCalledTimes(1);
    expect(store.savePartial.mock.calls.at(-1)?.[1].steps).toHaveLength(3);
  });

  it('returns from the step without waiting for the upload', async () => {
    const upload = deferred();
    let uploaded = false;
    store.savePartial.mockImplementation(async () => {
      await upload.promise;
      uploaded = true;
    });

    await recorder.appendStep(OPERATION_ID, stepParams(0));
    expect(uploaded).toBe(false);

    upload.resolve();
    await recorder.flushPartial();
    expect(uploaded).toBe(true);
  });

  it('collapses steps appended during an upload into a single follow-up upload', async () => {
    const first = deferred();
    store.savePartial.mockImplementationOnce(async () => {
      await first.promise;
    });

    await recorder.appendStep(OPERATION_ID, stepParams(0));
    await recorder.appendStep(OPERATION_ID, stepParams(1));
    await recorder.appendStep(OPERATION_ID, stepParams(2));
    await vi.waitFor(() => expect(store.savePartial.mock.calls[0]?.[1].steps).toHaveLength(3));

    first.resolve();
    await recorder.flushPartial();

    // One upload for step 0, one for the three that landed while it ran.
    expect(store.savePartial).toHaveBeenCalledTimes(2);
    expect(store.savePartial.mock.calls.at(-1)?.[1].steps).toHaveLength(3);
  });

  it('keeps a human-wait snapshot readable while the same operation can resume', async () => {
    let partial: Partial<ExecutionSnapshot> | null = null;
    store.loadPartial.mockImplementation(async () => structuredClone(partial));
    store.savePartial.mockImplementation(async (_id, value) => {
      partial = structuredClone(value);
    });
    store.removePartial.mockImplementation(async () => {
      partial = null;
    });

    await recorder.appendStep(OPERATION_ID, stepParams(0));
    await recorder.finalize(OPERATION_ID, { completionReason: 'waiting_for_human', state: {} });
    expect(store.save.mock.calls[0][0].completionReason).toBe('waiting_for_human');

    const resumedRecorder = new OperationTraceRecorder(store);
    await resumedRecorder.appendStep(OPERATION_ID, stepParams(1));
    await resumedRecorder.finalize(OPERATION_ID, { completionReason: 'done', state: {} });

    expect(store.save.mock.calls.at(-1)?.[0].steps.map((step) => step.stepIndex)).toEqual([0, 1]);
    expect(store.removePartial).toHaveBeenCalledTimes(1);
  });

  it('finalizes from memory and deletes the partial after the final snapshot', async () => {
    await recorder.appendStep(OPERATION_ID, stepParams(0));
    await recorder.finalize(OPERATION_ID, { completionReason: 'done', state: {} });

    expect(store.loadPartial).toHaveBeenCalledTimes(1);
    expect(store.save).toHaveBeenCalledTimes(1);
    expect(store.save.mock.calls[0][0].steps).toHaveLength(1);
    expect(store.removePartial).toHaveBeenCalledTimes(1);
    expect(store.save.mock.invocationCallOrder[0]).toBeLessThan(
      store.removePartial.mock.invocationCallOrder[0],
    );
  });

  it('does not finalize a partial read after ownership is lost', async () => {
    const reading = deferred();
    const read = deferred();
    store.loadPartial.mockImplementation(async () => {
      reading.resolve();
      await read.promise;
      return { steps: [{ stepIndex: 0 } as any] };
    });
    const finalizing = recorder.finalize(OPERATION_ID, { completionReason: 'done', state: {} });
    await reading.promise;

    recorder.discardPartial();
    read.resolve();
    await finalizing;

    expect(store.save).not.toHaveBeenCalled();
    expect(store.removePartial).not.toHaveBeenCalled();
  });

  it('does not delete the next owner partial after an in-flight final save', async () => {
    const saving = deferred();
    const upload = deferred();
    store.loadPartial.mockResolvedValue({ steps: [{ stepIndex: 0 } as any] });
    store.save.mockImplementation(async () => {
      saving.resolve();
      await upload.promise;
    });
    const finalizing = recorder.finalize(OPERATION_ID, { completionReason: 'done', state: {} });
    await saving.promise;

    recorder.discardPartial();
    upload.resolve();
    await finalizing;

    expect(store.removePartial).not.toHaveBeenCalled();
  });

  it('does not upload steps after the operation lock is lost', async () => {
    const first = deferred();
    store.savePartial.mockImplementationOnce(async () => {
      await first.promise;
    });

    await recorder.appendStep(OPERATION_ID, stepParams(0));
    await vi.waitFor(() => expect(store.savePartial).toHaveBeenCalledTimes(1));
    await recorder.appendStep(OPERATION_ID, stepParams(1));
    recorder.discardPartial();

    first.resolve();
    await recorder.flushPartial();

    expect(store.savePartial).toHaveBeenCalledTimes(1);
  });

  it('aborts the upload in flight when the operation is handed over', async () => {
    const upload = deferred();
    let seenSignal: AbortSignal | undefined;
    store.savePartial.mockImplementation(async (_id, _partial, options) => {
      seenSignal = options?.signal;
      await upload.promise;
    });

    await recorder.appendStep(OPERATION_ID, stepParams(0));
    await vi.waitFor(() => expect(seenSignal?.aborted).toBe(false));

    recorder.discardPartial();

    // The upload already on the wire is cancelled, so it cannot land on top of
    // the partial the new owner is writing.
    expect(seenSignal?.aborted).toBe(true);

    upload.resolve();
    await recorder.flushPartial();
    expect(store.savePartial).toHaveBeenCalledTimes(1);
  });

  it('accumulates ordered steps while the initial trace read is pending and joins it at flush', async () => {
    const read = deferred();
    store.loadPartial.mockImplementationOnce(async () => {
      await read.promise;
      return { steps: [{ stepIndex: 0 } as any] };
    });
    await recorder.appendStep(OPERATION_ID, stepParams(1));
    await recorder.appendStep(OPERATION_ID, stepParams(2));
    let durable = false;
    const flush = recorder.flushPartial().then(() => {
      durable = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(durable).toBe(false);
    expect(store.savePartial).not.toHaveBeenCalled();
    read.resolve();
    await flush;
    expect(store.loadPartial).toHaveBeenCalledTimes(1);
    expect(store.savePartial.mock.calls.at(-1)?.[1].steps?.map((step) => step.stepIndex)).toEqual([
      0, 1, 2,
    ]);
  });

  it('discards pending trace reads and queued steps after ownership is lost', async () => {
    const read = deferred();
    store.loadPartial.mockImplementationOnce(async () => {
      await read.promise;
      return { steps: [] };
    });
    await recorder.appendStep(OPERATION_ID, stepParams(0));
    await recorder.appendStep(OPERATION_ID, stepParams(1));
    recorder.discardPartial();
    read.resolve();
    await recorder.flushPartial();
    expect(store.savePartial).not.toHaveBeenCalled();

    await recorder.appendStep('new-operation', stepParams(0));
    await recorder.flushPartial();
    expect(store.savePartial).toHaveBeenCalledTimes(1);
    expect(store.savePartial.mock.calls[0][0]).toBe('new-operation');
    expect(store.savePartial.mock.calls[0][1].steps).toHaveLength(1);
  });

  it('captures CE JSON values before a pending read lets the next step mutate them', async () => {
    const read = deferred();
    store.loadPartial.mockImplementationOnce(async () => {
      await read.promise;
      return null;
    });
    const document = { createdAt: new Date('2026-10-30T00:00:00.000Z'), title: 'original' };
    const metadata = { decision: 'keep' };
    const output = { messages: ['original'] };
    await recorder.appendStep(OPERATION_ID, {
      ...stepParams(0),
      contextEngine: { input: { documents: [document] }, metadata, output },
    });

    document.title = 'next step';
    document.createdAt.setUTCFullYear(2027);
    metadata.decision = 'trim';
    output.messages.push('next step');
    read.resolve();
    await recorder.flushPartial();

    expect(store.savePartial.mock.calls.at(-1)?.[1].steps?.[0].contextEngine).toEqual({
      input: { documents: [{ createdAt: '2026-10-30T00:00:00.000Z', title: 'original' }] },
      metadata: { decision: 'keep' },
      output: { messages: ['original'] },
    });
  });

  it('does not reuse a discarded operation cache after waiting for another upload', async () => {
    const upload = deferred();
    store.savePartial.mockImplementationOnce(async () => {
      await upload.promise;
    });
    await recorder.appendStep('previous', stepParams(0));
    await vi.waitFor(() => expect(store.savePartial).toHaveBeenCalledTimes(1));
    await recorder.appendStep('next', stepParams(0));
    await new Promise<void>((resolve) => setImmediate(resolve));
    recorder.discardPartial();
    upload.resolve();
    await recorder.flushPartial();
    expect(store.savePartial).toHaveBeenCalledTimes(1);

    await recorder.appendStep('next', stepParams(0));
    await recorder.flushPartial();
    expect(store.loadPartial.mock.calls.filter(([id]) => id === 'next')).toHaveLength(2);
    expect(store.savePartial.mock.calls.at(-1)?.[1].steps).toHaveLength(1);
  });

  it('is a no-op without a store', async () => {
    const disabled = new OperationTraceRecorder(null);
    await disabled.appendStep(OPERATION_ID, stepParams(0));
    await expect(disabled.flushPartial()).resolves.toBeUndefined();
  });
});

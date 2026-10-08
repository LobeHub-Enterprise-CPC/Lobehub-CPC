// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChannelModel } from '@/database/models/channel';
import type { channelRuns } from '@/database/privateSchemas/channel';
import type { LobeChatDatabase } from '@/database/type';

import { ChannelWorker } from './worker';

const { native, artifactRunIds } = vi.hoisted(() => ({
  artifactRunIds: vi.fn(async () => [] as string[]),
  native: vi.fn(),
}));
vi.mock('./native/host', () => ({ runChannelNative: native }));
vi.mock('./native/capabilities', () => ({ checkChannelNativeAvailability: vi.fn() }));
vi.mock('./artifact', () => ({ resolveChannelArtifactRunIds: artifactRunIds }));
vi.mock('./serverDefault', () => ({ settleChannelServerDefaultOperation: vi.fn() }));

const run = { id: 'run', channelId: 'channel', fence: 1 } as typeof channelRuns.$inferSelect;
const config = { runtime: 'native' as const, model: 'model', provider: 'provider' };
const model = {
  accepted: vi.fn(),
  fail: vi.fn(),
  releaseWriter: vi.fn(),
  executionUnknown: vi.fn(),
  recordExecution: vi.fn(),
  saveDraft: vi.fn(),
  publish: vi.fn(),
};
// Exercise the detached lifecycle directly; tick's DB selection is independent of this fault.
const start = (worker: ChannelWorker) =>
  worker['startNative'](model as unknown as ChannelModel, 'owner', run, config, 'agent');
beforeEach(() => {
  vi.clearAllMocks();
  artifactRunIds.mockResolvedValue([]);
  for (const method of Object.values(model)) method.mockResolvedValue(undefined);
});

describe('Channel Native worker settlement', () => {
  it('hands the run to execAgent with the authorized artifact allowlist and publishes the final', async () => {
    artifactRunIds.mockResolvedValue(['run-a']);
    native.mockImplementation(async ({ onAccepted }) => {
      await onAccepted('session', 'op_1');
      return {
        budget: { activeMs: 10, modelCalls: 2, toolCalls: 1 },
        content: 'Reply',
        operationId: 'op_1',
        state: { modelRuntimeConfig: { model: 'current-model', provider: 'current-provider' } },
      };
    });
    const worker = new ChannelWorker({} as LobeChatDatabase);
    await start(worker);
    await worker['active'].get(run.id)?.done;
    await worker.close();
    expect(native).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent',
        artifactRunIds: ['run-a'],
        ownerId: 'owner',
        run,
      }),
    );
    expect(model.accepted).toHaveBeenCalledWith('channel', 'run', 1, 'session', 'op_1');
    expect(model.recordExecution).toHaveBeenCalledWith('channel', 'run', 1, {
      activeMs: 10,
      model: 'current-model',
      modelCalls: 2,
      provider: 'current-provider',
      runtime: 'native',
      toolCalls: 1,
    });
    expect(model.saveDraft).toHaveBeenCalledWith('channel', 'run', 1, 'Reply');
    expect(model.publish).toHaveBeenCalled();
    expect(model.releaseWriter).toHaveBeenCalledTimes(1);
    expect(model.fail).not.toHaveBeenCalled();
    expect(model.executionUnknown).not.toHaveBeenCalled();
  });

  it('records the runtime failure and releases the writer', async () => {
    native.mockRejectedValue(new Error('Channel model call limit reached'));
    const worker = new ChannelWorker({} as LobeChatDatabase);
    await start(worker);
    await worker.close();
    expect(model.fail).toHaveBeenCalledWith(
      'channel',
      'run',
      1,
      'Channel model call limit reached',
    );
    expect(model.releaseWriter).toHaveBeenCalledTimes(1);
    expect(model.publish).not.toHaveBeenCalled();
  });

  it.each(['fail', 'releaseWriter'] as const)(
    'contains %s rejection and retries finalization without replay',
    async (method) => {
      native.mockRejectedValue(new Error('Provider failure'));
      model[method].mockRejectedValueOnce(new Error('Database temporarily unavailable'));
      const worker = new ChannelWorker({} as LobeChatDatabase);
      await start(worker);
      await expect(worker['active'].get(run.id)!.done).resolves.toBeUndefined();
      expect(worker['finalizing'].has(run.id)).toBe(true);
      await worker.close();
      expect(worker['finalizing'].size).toBe(0);
      expect(native).toHaveBeenCalledTimes(1);
      expect(model.releaseWriter).toHaveBeenCalled();
    },
  );

  it('aborts the runtime signal on close and settles a late return as failure', async () => {
    let finish!: (value: unknown) => void;
    let signal!: AbortSignal;
    native.mockImplementation(
      (input) =>
        new Promise((resolve) => {
          signal = input.signal;
          finish = resolve;
        }),
    );
    const worker = new ChannelWorker({} as LobeChatDatabase);
    await start(worker);
    const closing = worker.close();
    expect(signal.aborted).toBe(true);
    finish({ content: 'Late reply', budget: {}, state: {} });
    await closing;
    expect(model.fail).toHaveBeenCalledWith(
      'channel',
      'run',
      1,
      'Native execution was interrupted',
    );
    expect(model.publish).not.toHaveBeenCalled();
    expect(model.releaseWriter).toHaveBeenCalledTimes(1);
  });

  it('keeps an acknowledged draft recoverable when publication fails', async () => {
    native.mockResolvedValue({
      content: 'Saved reply',
      budget: {},
      state: { modelRuntimeConfig: { model: 'current-model', provider: 'current-provider' } },
    });
    model.publish.mockRejectedValueOnce(new Error('Publish unavailable'));
    const worker = new ChannelWorker({} as LobeChatDatabase);
    await start(worker);
    await worker.close();
    expect(model.saveDraft).toHaveBeenCalled();
    expect(model.recordExecution).toHaveBeenCalledWith(
      'channel',
      'run',
      1,
      expect.objectContaining({ model: 'current-model', provider: 'current-provider' }),
    );
    expect(model.fail).not.toHaveBeenCalled();
    expect(model.releaseWriter).toHaveBeenCalled();
  });
});

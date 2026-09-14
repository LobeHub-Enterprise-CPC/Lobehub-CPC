// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChannelModel } from '@/database/models/channel';
import type { channelRuns } from '@/database/privateSchemas/channel';
import type { LobeChatDatabase } from '@/database/type';

import type { ChannelNativeCapabilities } from './native/host';
import { ChannelWorker } from './worker';

const { native } = vi.hoisted(() => ({ native: vi.fn() }));
vi.mock('./native/host', () => ({
  runChannelNative: native,
  isChannelApprovalCheckpoint: () => false,
}));
vi.mock('./native/capabilities', () => ({ loadChannelNativeCapabilities: vi.fn() }));
vi.mock('./artifact', () => ({
  channelArtifactCapability: async () => ({ tools: [], toolManifestMap: {} }),
}));
vi.mock('./serverDefault', () => ({ settleChannelServerDefaultOperation: vi.fn() }));

const run = { id: 'run', channelId: 'channel', fence: 1 } as typeof channelRuns.$inferSelect;
const config = { runtime: 'native' as const, model: 'model', provider: 'provider' };
const capabilities = { tools: [], toolManifestMap: {} } as unknown as ChannelNativeCapabilities;
const model = {
  fail: vi.fn(),
  releaseWriter: vi.fn(),
  executionUnknown: vi.fn(),
  recordExecution: vi.fn(),
  saveDraft: vi.fn(),
  publish: vi.fn(),
};
// Exercise the detached lifecycle directly; tick's DB selection is independent of this fault.
const start = (worker: ChannelWorker) =>
  worker['startNative'](model as unknown as ChannelModel, 'owner', run, config, capabilities);
beforeEach(() => {
  vi.clearAllMocks();
  for (const method of Object.values(model)) method.mockResolvedValue(undefined);
});

describe('Channel Native worker settlement', () => {
  it('releases a completed run when a tool returns a confirmed provider error', async () => {
    native.mockImplementation(async ({ capabilities: runtimeCapabilities }) => {
      await runtimeCapabilities.toolTransport.run({}, {});
      return { content: 'The search provider is unavailable', budget: {}, state: {} };
    });
    const worker = new ChannelWorker({} as LobeChatDatabase);
    await worker['startNative'](model as unknown as ChannelModel, 'owner', run, config, {
      ...capabilities,
      toolTransport: {
        run: async () => ({
          attempts: 1,
          result: { success: false, content: 'Provider not configured' },
        }),
      },
    });
    await worker['active'].get(run.id)?.done;
    await worker.close();
    expect(model.publish).toHaveBeenCalled();
    expect(model.releaseWriter).toHaveBeenCalled();
    expect(model.executionUnknown).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'retains the writer after a resolved transport failure, runtime fails=%s',
    async (fails) => {
      native.mockImplementation(async ({ capabilities: runtimeCapabilities }) => {
        await runtimeCapabilities.toolTransport.run({}, {});
        if (fails) throw new Error('Device response lost');
        return { content: 'Device response lost', budget: {}, state: {} };
      });
      const worker = new ChannelWorker({} as LobeChatDatabase);
      await worker['startNative'](model as unknown as ChannelModel, 'owner', run, config, {
        ...capabilities,
        toolTransport: {
          run: async () => ({
            attempts: 1,
            result: {
              content: 'Device response lost',
              executionUnknown: true,
              success: false,
            },
          }),
        },
      });
      await worker['active'].get(run.id)?.done;
      await worker.close();
      expect(model.releaseWriter).not.toHaveBeenCalled();
      expect(model.executionUnknown).toHaveBeenCalledWith(
        'channel',
        'run',
        1,
        'Tool termination could not be confirmed',
      );
    },
  );

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

  it('settles an aborted successful return as failure instead of an unpublished completed zombie', async () => {
    let finish!: (value: unknown) => void;
    native.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const worker = new ChannelWorker({} as LobeChatDatabase);
    await start(worker);
    const closing = worker.close();
    finish({ content: 'Late reply' });
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
      expect.objectContaining({
        model: 'current-model',
        provider: 'current-provider',
      }),
    );
    expect(model.fail).not.toHaveBeenCalled();
    expect(model.releaseWriter).toHaveBeenCalled();
  });
});

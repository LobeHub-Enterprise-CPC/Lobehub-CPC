import { mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { expect, it, vi } from 'vitest';

import { CodexChannelHost, type CodexChannelStart } from './host';

it.each(['physicalStopped', 'runtimeCompleted'] as const)(
  'persists %s before eviction and deduplicates renewed credentials',
  async (completion) => {
    const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'channel-receipt-')));
    try {
      const host = new CodexChannelHost(path.join(directory, 'journal'));
      host['execute'] = vi.fn(async (key, _input, execution) => {
        execution.snapshot.status = 'completed';
        execution.snapshot[completion] = true;
        execution.snapshot.content = 'Preserved reply';
        await host['persist'](key, execution);
      });
      const input: CodexChannelStart = {
        ownerId: 'owner',
        runId: 'run',
        cwd: directory,
        fence: 1,
        model: 'model',
        serverDefaultBinding: { model: 'lobehub-default', token: 'original' },
        manifest: {
          cutoffSequence: 1,
          messages: [],
          requestMessageId: 'message',
          sessionGeneration: 1,
          source: 'reconstructed',
          threadId: null,
        },
      };
      await host.start(input);
      await Promise.all([...host['runs'].values()].map((entry) => entry.done));
      await host.inspect('owner', 'run');
      expect(host['runs'].size).toBe(completion === 'physicalStopped' ? 0 : 1);
      expect((await host.start(input)).content).toBe('Preserved reply');
      expect(host['execute']).toHaveBeenCalledTimes(1);
      expect(
        (await readdir(path.join(directory, 'journal'))).filter((name) => name.endsWith('.tmp')),
      ).toEqual([]);
      const restarted = new CodexChannelHost(path.join(directory, 'journal'));
      expect(
        (
          await restarted.start({
            ...input,
            serverDefaultBinding: { model: 'lobehub-default', token: 'renewed' },
          })
        ).content,
      ).toBe('Preserved reply');
      await expect(restarted.start({ ...input, fence: 2 })).rejects.toThrow('input changed');
      if (completion === 'runtimeCompleted') {
        expect(await restarted.stop('owner', 'run', 1)).toMatchObject({
          status: 'execution_unknown',
          physicalStopped: false,
        });
        const execution = [...host['runs'].values()][0];
        const terminate = vi
          .spyOn(execution.client, 'closeAndConfirmTermination')
          .mockResolvedValue(true);
        expect(await host.stop('owner', 'run', 1)).toMatchObject({
          status: 'stopped',
          physicalStopped: true,
        });
        expect(terminate).toHaveBeenCalledOnce();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it('does not replay an uncertain receipt after host restart', async () => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'channel-unknown-')));
  try {
    const journal = path.join(directory, 'journal');
    const host = new CodexChannelHost(journal);
    host['execute'] = vi.fn(async () => {});
    const input: CodexChannelStart = {
      ownerId: 'owner',
      runId: 'unknown',
      cwd: directory,
      fence: 1,
      model: '',
      manifest: {
        cutoffSequence: 1,
        messages: [],
        requestMessageId: 'message',
        sessionGeneration: 1,
        source: 'reconstructed',
        threadId: null,
      },
    };
    await host.start(input);
    await Promise.all([...host['runs'].values()].map((entry) => entry.done));
    const restarted = new CodexChannelHost(journal);
    restarted['execute'] = vi.fn();
    expect(await restarted.start(input)).toMatchObject({
      status: 'execution_unknown',
      acceptance: 'unknown',
      physicalStopped: false,
    });
    expect(restarted['execute']).not.toHaveBeenCalled();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

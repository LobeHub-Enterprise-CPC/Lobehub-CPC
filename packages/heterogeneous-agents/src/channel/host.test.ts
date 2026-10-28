import { mkdtemp, open, readdir, readFile, realpath, rename, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { CodexChannelHost, type CodexChannelStart } from './host';

const { actualOpen, actualRename } = await vi.hoisted(async () => {
  const fs = await import('node:fs/promises');
  return { actualOpen: fs.open, actualRename: fs.rename };
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    open: vi.fn(actual.open as typeof actualOpen),
    rename: vi.fn(actual.rename as typeof actualRename),
  };
});

const eperm = () =>
  Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });

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
        attachmentContext: [{ messageId: 'message', content: 'signed-original', imageList: [] }],
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
            attachmentContext: [{ messageId: 'message', content: 'signed-renewed', imageList: [] }],
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

describe('receipt writes', () => {
  const platform = process.platform;
  const setPlatform = (value: NodeJS.Platform) =>
    Object.defineProperty(process, 'platform', { configurable: true, value });

  afterEach(() => {
    setPlatform(platform);
    vi.mocked(open).mockImplementation(actualOpen);
    vi.mocked(rename).mockReset().mockImplementation(actualRename);
  });

  const withJournal = async (run: (host: CodexChannelHost, journal: string) => Promise<void>) => {
    const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'channel-write-')));
    try {
      await run(
        new CodexChannelHost(path.join(directory, 'journal')),
        path.join(directory, 'journal'),
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  };

  it('does not fsync the journal directory on Windows, where directory handles reject fsync', async () => {
    setPlatform('win32');
    // Mirror Windows: a directory handle opened read-only rejects sync() with EPERM.
    vi.mocked(open).mockImplementation(async (...args: Parameters<typeof actualOpen>) => {
      const handle = await actualOpen(...args);
      if (args[1] !== 'r') return handle;
      return Object.assign(handle, {
        sync: async () => {
          throw Object.assign(new Error('EPERM: operation not permitted, fsync'), {
            code: 'EPERM',
          });
        },
      });
    });

    await withJournal(async (host, journal) => {
      await expect(host['write']('receipt', '{"status":"running"}')).resolves.toBeUndefined();
      expect(await readFile(path.join(journal, 'receipt.json'), 'utf8')).toBe(
        '{"status":"running"}',
      );
    });
  });

  it('still fsyncs the journal directory on POSIX platforms', async () => {
    setPlatform('linux');
    const syncedDirectories: string[] = [];
    vi.mocked(open).mockImplementation(async (...args: Parameters<typeof actualOpen>) => {
      const handle = await actualOpen(...args);
      if (args[1] !== 'r') return handle;
      const sync = handle.sync.bind(handle);
      return Object.assign(handle, {
        sync: async () => {
          syncedDirectories.push(String(args[0]));
          // Skip the real call so the assertion holds on a Windows test runner too.
          if (platform !== 'win32') await sync();
        },
      });
    });

    await withJournal(async (host, journal) => {
      await host['write']('receipt', '{}');
      expect(syncedDirectories).toEqual([journal]);
    });
  });

  it('retries a Windows rename that a transient file lock rejects', async () => {
    setPlatform('win32');
    vi.mocked(rename)
      .mockRejectedValueOnce(eperm())
      .mockRejectedValueOnce(eperm())
      .mockImplementation(actualRename);

    await withJournal(async (host, journal) => {
      await expect(host['write']('receipt', '{"status":"running"}')).resolves.toBeUndefined();
      expect(await readFile(path.join(journal, 'receipt.json'), 'utf8')).toBe(
        '{"status":"running"}',
      );
      expect((await readdir(journal)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    });
  });

  it('lets inspect and stop recover after a failed receipt write', async () => {
    setPlatform('linux');
    await withJournal(async (host, journal) => {
      host['execute'] = vi.fn(async () => {});
      await host.start({
        ownerId: 'owner',
        runId: 'locked',
        cwd: path.dirname(journal),
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
      });
      const [[key, execution]] = [...host['runs'].entries()];
      execution.snapshot.status = 'running';
      vi.mocked(rename).mockRejectedValueOnce(eperm());
      await expect(host['persist'](key, execution)).rejects.toThrow('EPERM');

      // The lock is gone: the next inspect must persist again instead of replaying the old error.
      expect(await host.inspect('owner', 'locked')).toMatchObject({ status: 'running' });
      expect(JSON.parse(await readFile(path.join(journal, `${key}.json`), 'utf8'))).toMatchObject({
        status: 'running',
      });

      vi.spyOn(execution.client, 'closeAndConfirmTermination').mockResolvedValue(true);
      expect(await host.stop('owner', 'locked', 1)).toMatchObject({
        status: 'stopped',
        physicalStopped: true,
      });
      expect(host['runs'].size).toBe(0);
    });
  });
});

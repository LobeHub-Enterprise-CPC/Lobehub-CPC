// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { LobeChatDatabase } from '@/database/type';

import { ChannelDeviceStartError } from './device';
import { isChannelEnabled } from './gate';
import { routeChannelMessage } from './router';
import { ChannelWorker } from './worker';

const { methods, inspect, probe, start, stopDevice, settleOperation, deviceConstructor } =
  vi.hoisted(() => ({
    methods: {
      stop: vi.fn(),
      executionUnknown: vi.fn(),
      fail: vi.fn(),
      unavailable: vi.fn(),
      claim: vi.fn(),
      recordExecution: vi.fn(),
      saveDraft: vi.fn(),
      publish: vi.fn(),
      releaseWriter: vi.fn(),
      recordEnvironmentCleanup: vi.fn(),
    },
    deviceConstructor: vi.fn(),
    inspect: vi.fn(),
    probe: vi.fn(),
    start: vi.fn(),
    stopDevice: vi.fn(),
    settleOperation: vi.fn(),
  }));
vi.mock('@/database/models/channel', () => ({
  ChannelModel: class {
    constructor() {
      return methods;
    }
  },
}));
vi.mock('./device', () => ({
  ChannelDeviceStartError: class extends Error {
    constructor(
      message: string,
      readonly submission: 'not-submitted' | 'unknown',
    ) {
      super(message);
    }
  },
  ChannelDevice: class {
    constructor(...args: unknown[]) {
      deviceConstructor(...args);
    }
    inspect = inspect;
    probe = probe;
    start = start;
    stop = stopDevice;
  },
}));
vi.mock('./gate', () => ({ isChannelEnabled: vi.fn() }));
vi.mock('./router', () => ({ routeChannelMessage: vi.fn() }));
vi.mock('./native/host', () => ({ runChannelNative: vi.fn() }));
vi.mock('./native/capabilities', () => ({
  checkChannelNativeAvailability: async () => ({
    agentId: 'agent',
    model: 'model',
    provider: 'provider',
  }),
}));
vi.mock('./artifact', () => ({ resolveChannelArtifactRunIds: async () => [] }));
vi.mock('./serverDefault', () => ({ settleChannelServerDefaultOperation: settleOperation }));

const channel = { id: 'channel', ownerId: 'owner', archived: false };
function database(rows: unknown[][]) {
  const chain = (result: unknown) => {
    const query = Promise.resolve(result);
    Object.assign(query, {
      from: () => query,
      innerJoin: () => query,
      where: () => query,
      orderBy: () => query,
      limit: () => query,
    });
    return query;
  };
  return {
    select: () => chain(rows.shift()!),
    /** The discussion sweep sees no active discussions in these isolation tests. */
    selectDistinct: () => chain([]),
  } as unknown as LobeChatDatabase;
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(isChannelEnabled).mockResolvedValue(true);
  for (const method of Object.values(methods)) method.mockResolvedValue(undefined);
  methods.claim.mockResolvedValue(null);
});

describe('Channel dispatch isolation', () => {
  it('skips disabled owners and routes at most one request per tick without overlapping ticks', async () => {
    vi.mocked(isChannelEnabled).mockImplementation(async (_, ownerId) => ownerId !== 'disabled');
    let finish!: () => void;
    vi.mocked(routeChannelMessage).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const worker = new ChannelWorker(
      database([
        [],
        [
          { ownerId: 'disabled', message: { channelId: 'disabled-channel', id: 'blocked' } },
          { ownerId: 'owner', message: { channelId: 'channel', id: 'first' } },
          { ownerId: 'owner', message: { channelId: 'channel', id: 'second' } },
        ],
        [],
        [],
        [{ ownerId: 'owner', message: { channelId: 'channel', id: 'second' } }],
        [],
      ]),
    );
    const ticking = worker.tick();
    await vi.waitFor(() => expect(routeChannelMessage).toHaveBeenCalledOnce());
    await worker.tick();
    expect(routeChannelMessage).toHaveBeenCalledOnce();
    expect(routeChannelMessage).toHaveBeenLastCalledWith(methods, 'channel', 'first');
    finish();
    await ticking;
    expect(routeChannelMessage).toHaveBeenCalledOnce();
    await worker.tick();
    expect(routeChannelMessage).toHaveBeenCalledTimes(2);
    expect(routeChannelMessage).toHaveBeenLastCalledWith(methods, 'channel', 'second');
  });

  it('does not claim queued work when the asynchronous Labs gate is off', async () => {
    vi.mocked(isChannelEnabled).mockResolvedValue(false);
    const worker = new ChannelWorker(
      database([
        [],
        [],
        [{ channel, config: { runtime: 'native' }, revision: 3, job: { id: 'queued' } }],
      ]),
    );
    await worker.tick();
    expect(isChannelEnabled).toHaveBeenCalledWith(expect.anything(), 'owner');
    expect(methods.claim).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it('revokes unpublished runs when Labs is switched off instead of publishing their drafts', async () => {
    vi.mocked(isChannelEnabled).mockResolvedValue(false);
    const worker = new ChannelWorker(
      database([
        [
          {
            channel,
            memberActive: true,
            run: {
              id: 'draft',
              executionConfig: { runtime: 'native' },
              publicationRevoked: false,
              writerReleased: true,
              draft: 'unpublished result',
            },
          },
        ],
        [],
        [],
      ]),
    );
    await worker.tick();
    expect(methods.stop).toHaveBeenCalledWith(channel.id, { runId: 'draft' });
    expect(methods.publish).not.toHaveBeenCalled();
  });

  it('publishes a completed native turn without requiring workspace capture or killing background tools', async () => {
    inspect.mockResolvedValue({
      acceptance: 'accepted',
      content: 'done',
      fence: 1,
      physicalStopped: false,
      runtimeCompleted: true,
      runId: 'running',
      status: 'completed',
    });
    const worker = new ChannelWorker(
      database([
        [
          {
            channel,
            memberActive: true,
            config: { runtime: 'codex', deviceId: 'device' },
            run: {
              id: 'running',
              channelId: channel.id,
              fence: 1,
              executionFence: 1,
              executionConfig: { runtime: 'codex', deviceId: 'device' },
              publicationRevoked: false,
              writerReleased: false,
              draft: null,
            },
          },
        ],
        [],
        [],
      ]),
    );
    await worker.tick();
    expect(settleOperation).toHaveBeenCalledWith({
      db: expect.anything(),
      ownerId: 'owner',
      runId: 'running',
      status: 'done',
    });
    expect(methods.publish).toHaveBeenCalledWith(channel.id, 'running', 1);
    expect(methods.releaseWriter).toHaveBeenCalledWith(channel.id, 'running', 1);
  });

  it('does not make queued work wait for an unrelated device inspection', async () => {
    let finish!: (value: null) => void;
    inspect.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const worker = new ChannelWorker(
      database([
        [
          {
            channel,
            memberActive: true,
            config: { runtime: 'codex', deviceId: 'slow' },
            run: {
              id: 'running',
              channelId: channel.id,
              fence: 1,
              executionFence: 1,
              executionConfig: { runtime: 'codex', deviceId: 'slow' },
              publicationRevoked: false,
              writerReleased: false,
              draft: null,
            },
          },
        ],
        [],
        [{ channel, config: { runtime: 'native' }, revision: 3, job: { id: 'queued' } }],
      ]),
    );
    const ticking = worker.tick();
    await vi.waitFor(() => expect(methods.claim).toHaveBeenCalledWith(channel.id, 'queued', 3));
    finish(null);
    await ticking;
    expect(methods.executionUnknown).toHaveBeenCalledWith(
      channel.id,
      'running',
      1,
      expect.any(String),
    );
  });

  it('reports canonical directory drift without claiming or switching the workspace', async () => {
    probe.mockResolvedValue('/changed');
    const worker = new ChannelWorker(
      database([
        [],
        [],
        [
          {
            channel,
            config: { runtime: 'codex', deviceId: 'device', workingDirectory: '/original' },
            job: { id: 'queued' },
          },
        ],
      ]),
    );
    await worker.tick();
    expect(methods.claim).not.toHaveBeenCalled();
    expect(methods.unavailable).toHaveBeenCalledWith(
      channel.id,
      'queued',
      expect.stringContaining('WORKSPACE_CHANGED'),
    );
  });

  it('does not release a stopped run until physical termination is confirmed', async () => {
    stopDevice.mockResolvedValue({
      fence: 1,
      physicalStopped: false,
      runtimeCompleted: true,
      runId: 'stopped',
      status: 'completed',
    });
    const worker = new ChannelWorker(
      database([
        [
          {
            channel,
            memberActive: true,
            config: { runtime: 'codex', deviceId: 'device' },
            run: {
              id: 'stopped',
              channelId: channel.id,
              fence: 1,
              executionFence: 1,
              executionConfig: { runtime: 'codex', deviceId: 'device' },
              publicationRevoked: true,
              writerReleased: false,
              draft: null,
            },
          },
        ],
        [],
        [],
      ]),
    );
    await worker.tick();
    expect(methods.releaseWriter).not.toHaveBeenCalled();
    expect(settleOperation).not.toHaveBeenCalled();
  });

  it('fails and releases a definitely unsubmitted start, retrying database finalization', async () => {
    probe.mockResolvedValue('/repo');
    methods.claim.mockResolvedValue({
      run: {
        channelId: channel.id,
        fence: 1,
        executionFence: 1,
        executionConfig: { runtime: 'codex', deviceId: 'device', workingDirectory: '/repo' },
        id: 'claimed',
        manifest: {},
      },
      session: {},
    });
    start.mockRejectedValue(new ChannelDeviceStartError('preflight failed', 'not-submitted'));
    settleOperation.mockRejectedValueOnce(new Error('database unavailable'));
    const worker = new ChannelWorker(
      database([
        [],
        [],
        [
          {
            channel,
            config: { runtime: 'codex', deviceId: 'device', workingDirectory: '/repo' },
            job: { id: 'queued' },
          },
        ],
        [],
        [],
        [],
      ]),
    );
    await worker.tick();
    expect(methods.releaseWriter).not.toHaveBeenCalled();
    await worker.tick();
    expect(methods.fail).toHaveBeenCalledWith(
      channel.id,
      'claimed',
      1,
      'preflight failed',
      false,
      true,
    );
    expect(settleOperation).toHaveBeenCalledTimes(2);
    expect(methods.releaseWriter).not.toHaveBeenCalled(); // Released atomically by fail.
  });

  it('keeps an ambiguously accepted RPC for inspection without retrying or releasing it', async () => {
    probe.mockResolvedValue('/repo');
    methods.claim.mockResolvedValue({
      run: {
        channelId: channel.id,
        fence: 1,
        executionFence: 1,
        executionConfig: { runtime: 'codex', deviceId: 'device', workingDirectory: '/repo' },
        id: 'claimed',
        manifest: {},
      },
      session: {},
    });
    start.mockRejectedValue(new ChannelDeviceStartError('ack lost', 'unknown'));
    const worker = new ChannelWorker(
      database([
        [],
        [],
        [
          {
            channel,
            config: { runtime: 'codex', deviceId: 'device', workingDirectory: '/repo' },
            job: { id: 'queued' },
          },
        ],
      ]),
    );
    await worker.tick();
    expect(start).toHaveBeenCalledOnce();
    expect(methods.fail).not.toHaveBeenCalled();
    expect(methods.releaseWriter).not.toHaveBeenCalled();
    expect(settleOperation).not.toHaveBeenCalled();
  });

  it('releases a failed native process after physical confirmation without requiring a completed turn', async () => {
    inspect.mockResolvedValue({
      fence: 1,
      runId: 'failed',
      physicalStopped: true,
      status: 'failed',
    });
    const worker = new ChannelWorker(database([]));
    await worker['reconcileCodex'](
      methods as never,
      'owner',
      { id: 'failed', channelId: channel.id, fence: 1, executionFence: 1 } as never,
      { runtime: 'codex', deviceId: 'device' } as never,
      false,
    );
    expect(methods.releaseWriter).toHaveBeenCalledWith(channel.id, 'failed', 1);
    expect(methods.fail).toHaveBeenCalledWith(channel.id, 'failed', 1, expect.any(String), false);
    expect(settleOperation).toHaveBeenCalledWith(expect.objectContaining({ status: 'error' }));
  });

  it.each([true, false])(
    'cleans old background processes using the captured device and receipt fence, confirmed=%s',
    async (physicalStopped) => {
      stopDevice.mockResolvedValue({
        runId: 'old',
        fence: 1,
        physicalStopped,
        error: physicalStopped ? undefined : 'Device lost its process tracker',
      });
      const worker = new ChannelWorker(
        database([
          [
            {
              channel,
              memberActive: true,
              config: { runtime: 'codex', deviceId: 'new-device' },
              run: {
                id: 'old',
                channelId: channel.id,
                fence: 4,
                executionFence: 1,
                executionConfig: {
                  runtime: 'codex',
                  deviceId: 'old-device',
                  workingDirectory: '/old',
                },
                writerReleased: true,
                physicalStopped: false,
                cleanupRequested: true,
                publishedMessageId: 'published',
                publicationRevoked: false,
              },
            },
          ],
          [],
          [],
        ]),
      );
      await worker.tick();
      expect(deviceConstructor).toHaveBeenCalledWith(expect.anything(), 'owner', 'old-device');
      expect(stopDevice).toHaveBeenCalledWith('old', 1);
      expect(methods.recordEnvironmentCleanup).toHaveBeenCalledWith(
        channel.id,
        'old',
        4,
        physicalStopped,
        physicalStopped ? undefined : 'Device lost its process tracker',
      );
      expect(methods.publish).not.toHaveBeenCalled();
      expect(methods.fail).not.toHaveBeenCalled();
      expect(settleOperation).not.toHaveBeenCalled();
    },
  );
});

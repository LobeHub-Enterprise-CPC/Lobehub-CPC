import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { deviceService } from '@/services/device';

import { channelService } from './channel';

const { page, pauseMember, subscribe, unsubscribe, updateEnvironment, validateEnvironment } =
  vi.hoisted(() => ({
    page: vi.fn(),
    pauseMember: vi.fn(),
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    updateEnvironment: vi.fn(),
    validateEnvironment: vi.fn(),
  }));
vi.mock('@/libs/trpc/client', () => ({
  lambdaClient: {
    channel: {
      page: { query: page },
      pauseMember: { mutate: pauseMember },
      watch: { subscribe },
      updateEnvironment: { mutate: updateEnvironment },
      validateEnvironment: { mutate: validateEnvironment },
    },
  },
}));
vi.mock('@/services/device', () => ({
  deviceService: { listDevices: vi.fn(), updateDevice: vi.fn() },
}));

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  subscribe.mockReset();
  unsubscribe.mockReset();
  updateEnvironment.mockReset();
  validateEnvironment.mockReset();
  pauseMember.mockReset().mockResolvedValue({ confirmationRequired: false });
  page.mockReset().mockResolvedValue({
    channel: { archived: false },
    members: [{ id: 'member-b', active: true, executionPaused: true, environmentRevision: 7 }],
    runs: [],
  });
  vi.mocked(deviceService.listDevices).mockReset();
  vi.mocked(deviceService.updateDevice).mockReset();
  subscribe.mockReturnValue({ unsubscribe });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it('registers the explicitly selected root before probing and preserves freshly fetched device roots', async () => {
  vi.mocked(deviceService.listDevices).mockResolvedValue([
    {
      deviceId: 'remote',
      online: true,
      defaultCwd: '/default',
      workingDirs: [{ path: '/other-channel' }],
    },
  ] as never);
  vi.mocked(deviceService.updateDevice).mockResolvedValue(undefined as never);
  validateEnvironment.mockImplementation(async () => {
    expect(deviceService.updateDevice).toHaveBeenCalledWith({
      deviceId: 'remote',
      workingDirs: [{ path: '/chosen' }, { path: '/other-channel' }],
    });
    return { deviceId: 'remote', workingDirectory: '/canonical/chosen' };
  });
  await expect(
    channelService.validateEnvironment({
      agentId: 'codex',
      deviceId: 'remote',
      workingDirectory: ' /chosen ',
    }),
  ).resolves.toEqual({ deviceId: 'remote', workingDirectory: '/canonical/chosen' });
  expect(validateEnvironment).toHaveBeenCalledWith({
    agentId: 'codex',
    deviceId: 'remote',
    workingDirectory: '/chosen',
  });
});

it('does not authorize a directory or probe a disconnected device', async () => {
  vi.mocked(deviceService.listDevices).mockResolvedValue([
    { deviceId: 'remote', online: false },
  ] as never);
  await expect(
    channelService.validateEnvironment({
      agentId: 'codex',
      deviceId: 'remote',
      workingDirectory: '/chosen',
    }),
  ).rejects.toThrow();
  expect(deviceService.updateDevice).not.toHaveBeenCalled();
  expect(validateEnvironment).not.toHaveBeenCalled();
});

it('automatically prepares the selected directory on save and commits its canonical path with the original revision', async () => {
  vi.mocked(deviceService.listDevices).mockResolvedValue([
    { deviceId: 'remote', online: true, defaultCwd: '/default', workingDirs: [] },
  ] as never);
  validateEnvironment.mockImplementation(async () => {
    expect(updateEnvironment).not.toHaveBeenCalled();
    return { deviceId: 'remote', workingDirectory: '/canonical/repo' };
  });
  await channelService.updateEnvironment({
    agentId: 'codex',
    channelId: 'channel-b',
    memberId: 'member-b',
    expectedRevision: 7,
    deviceId: 'remote',
    workingDirectory: ' /symlink/repo ',
  });
  expect(validateEnvironment).toHaveBeenCalledExactlyOnceWith({
    agentId: 'codex',
    deviceId: 'remote',
    workingDirectory: '/symlink/repo',
  });
  expect(updateEnvironment).toHaveBeenCalledExactlyOnceWith({
    channelId: 'channel-b',
    memberId: 'member-b',
    expectedRevision: 7,
    deviceId: 'remote',
    workingDirectory: '/canonical/repo',
  });
});

it('does not commit an environment when the automatic save check fails', async () => {
  vi.mocked(deviceService.listDevices).mockResolvedValue([
    { deviceId: 'remote', online: true, defaultCwd: '/missing', workingDirs: [] },
  ] as never);
  validateEnvironment.mockRejectedValue(new Error('Directory does not exist'));
  await expect(
    channelService.updateEnvironment({
      agentId: 'codex',
      channelId: 'channel-b',
      memberId: 'member-b',
      expectedRevision: 7,
      deviceId: 'remote',
      workingDirectory: '/missing',
    }),
  ).rejects.toThrow('Directory does not exist');
  expect(pauseMember).not.toHaveBeenCalled();
  expect(updateEnvironment).not.toHaveBeenCalled();
});

describe('Environment switching', () => {
  const input = {
    agentId: 'codex',
    channelId: 'channel-b',
    memberId: 'member-b',
    expectedRevision: 7,
    deviceId: 'remote',
    workingDirectory: '/new',
  };
  const snapshot = (runs: object[], member = {}) => ({
    channel: { archived: false },
    members: [
      { id: 'member-b', active: true, executionPaused: true, environmentRevision: 7, ...member },
    ],
    runs,
  });
  beforeEach(() => {
    vi.mocked(deviceService.listDevices).mockResolvedValue([
      { deviceId: 'remote', online: true, defaultCwd: '/new' },
    ] as never);
    validateEnvironment.mockResolvedValue({
      deviceId: 'remote',
      workingDirectory: '/canonical/new',
    });
  });

  it('stops before any destructive action when the server requires confirmation', async () => {
    pauseMember.mockResolvedValue({ confirmationRequired: true });
    await expect(channelService.updateEnvironment(input)).resolves.toEqual({
      confirmationRequired: true,
    });
    expect(pauseMember).toHaveBeenCalledExactlyOnceWith({
      channelId: 'channel-b',
      memberId: 'member-b',
      expectedRevision: 7,
      onlyIfIdle: true,
    });
    expect(page).not.toHaveBeenCalled();
    expect(updateEnvironment).not.toHaveBeenCalled();
  });

  it('waits for both stop acknowledgements, ignores other members, and commits only after confirmation', async () => {
    page
      .mockResolvedValueOnce(
        snapshot([{ memberId: 'member-b', writerReleased: true, physicalStopped: false }]),
      )
      .mockResolvedValueOnce(
        snapshot([{ memberId: 'member-b', writerReleased: false, physicalStopped: true }]),
      )
      .mockResolvedValue(
        snapshot([
          { memberId: 'member-b', writerReleased: true, physicalStopped: true },
          { memberId: 'another-member', writerReleased: false, physicalStopped: false },
        ]),
      );
    const switching = channelService.updateEnvironment(input, true);
    await vi.advanceTimersByTimeAsync(0);
    expect(updateEnvironment).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(updateEnvironment).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    await expect(switching).resolves.toEqual({ confirmationRequired: false });
    expect(pauseMember).toHaveBeenCalledWith(expect.objectContaining({ onlyIfIdle: false }));
    expect(updateEnvironment).toHaveBeenCalledExactlyOnceWith({
      channelId: 'channel-b',
      memberId: 'member-b',
      expectedRevision: 7,
      deviceId: 'remote',
      workingDirectory: '/canonical/new',
    });
  });

  it('bounds cleanup waiting and does not save an environment that never stopped', async () => {
    page.mockResolvedValue(
      snapshot([{ memberId: 'member-b', writerReleased: true, physicalStopped: false }]),
    );
    const result = channelService.updateEnvironment(input, true).catch((error) => error);
    await vi.advanceTimersByTimeAsync(29_000);
    expect(updateEnvironment).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(await result).toBeInstanceOf(Error);
    expect(page).toHaveBeenCalledTimes(30);
    expect(updateEnvironment).not.toHaveBeenCalled();
  });

  it.each([{ environmentRevision: 8 }, { executionPaused: false }, { active: false }])(
    'does not switch if the member changes during cleanup: %j',
    async (member) => {
      page.mockResolvedValue(snapshot([], member));
      await expect(channelService.updateEnvironment(input, true)).rejects.toThrow();
      expect(updateEnvironment).not.toHaveBeenCalled();
    },
  );
});

describe('Channel snapshot subscription lifecycle', () => {
  it('disconnects while hidden, ignores stale callbacks, and reconnects when visible', () => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get');
    const data = vi.fn();
    const health = vi.fn();
    const watcher = channelService.watch('channel', data, health);
    const callbacks = subscribe.mock.calls[0][1];
    callbacks.onData({ revision: 'one', navigationRevision: 'nav' });
    callbacks.onError();
    visibility.mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    callbacks.onData({ revision: 'stale', navigationRevision: 'nav' });
    callbacks.onComplete();
    vi.advanceTimersByTime(60000);
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(data).toHaveBeenCalledTimes(1);
    expect(health).toHaveBeenLastCalledWith(false);
    visibility.mockReturnValue('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(subscribe).toHaveBeenCalledTimes(2);
    subscribe.mock.calls[1][1].onData({ revision: 'two', navigationRevision: 'nav' });
    expect(data).toHaveBeenLastCalledWith({ revision: 'two', navigationRevision: 'nav' });
    watcher.unsubscribe();
    document.dispatchEvent(new Event('visibilitychange'));
    expect(subscribe).toHaveBeenCalledTimes(2);
  });
  it('does not start a hidden subscription and avoids refetching identical revisions on reconnect', () => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    const data = vi.fn();
    const health = vi.fn();
    const watcher = channelService.watch('channel', data, health);
    expect(subscribe).not.toHaveBeenCalled();
    visibility.mockReturnValue('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    subscribe.mock.calls[0][1].onData({ revision: 'one', navigationRevision: 'nav' });
    subscribe.mock.calls[0][1].onComplete();
    vi.advanceTimersByTime(100);
    subscribe.mock.calls[1][1].onData({ revision: 'one', navigationRevision: 'nav' });
    expect(data).toHaveBeenCalledTimes(1);
    expect(health).toHaveBeenLastCalledWith(true);
    watcher.unsubscribe();
  });
  it('reconnects after a bounded stream ends and stops reconnecting after unmount', () => {
    const data = vi.fn();
    const watcher = channelService.watch('channel', data);
    const callbacks = subscribe.mock.calls[0][1];
    callbacks.onData({ revision: 1 });
    expect(data).toHaveBeenCalledWith({ revision: 1 });
    callbacks.onComplete();
    vi.advanceTimersByTime(100);
    expect(subscribe).toHaveBeenCalledTimes(2);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    watcher.unsubscribe();
    subscribe.mock.calls[1][1].onComplete();
    vi.advanceTimersByTime(20000);
    expect(subscribe).toHaveBeenCalledTimes(2);
  });
  it('backs off on an error and cancels pending recovery when leaving the channel', () => {
    const watcher = channelService.watch('channel', vi.fn());
    subscribe.mock.calls[0][1].onError();
    vi.advanceTimersByTime(1999);
    expect(subscribe).toHaveBeenCalledTimes(1);
    watcher.unsubscribe();
    vi.advanceTimersByTime(20000);
    expect(subscribe).toHaveBeenCalledTimes(1);
  });
  it('increases retry delay, reports lost health, and resets after a received snapshot', () => {
    const health = vi.fn();
    const watcher = channelService.watch('channel', vi.fn(), health);
    subscribe.mock.calls[0][1].onError();
    expect(health).toHaveBeenLastCalledWith(false);
    vi.advanceTimersByTime(2000);
    subscribe.mock.calls[1][1].onError();
    vi.advanceTimersByTime(3999);
    expect(subscribe).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1);
    subscribe.mock.calls[2][1].onData({ revision: 1 });
    expect(health).toHaveBeenLastCalledWith(true);
    subscribe.mock.calls[2][1].onError();
    vi.advanceTimersByTime(2000);
    expect(subscribe).toHaveBeenCalledTimes(4);
    watcher.unsubscribe();
  });
});

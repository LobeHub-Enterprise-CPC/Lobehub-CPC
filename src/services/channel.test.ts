import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { channelService } from './channel';

const { subscribe, unsubscribe } = vi.hoisted(() => ({ subscribe: vi.fn(), unsubscribe: vi.fn() }));
vi.mock('@/libs/trpc/client', () => ({ lambdaClient: { channel: { watch: { subscribe } } } }));

beforeEach(() => {
  vi.useFakeTimers();
  subscribe.mockReset();
  unsubscribe.mockReset();
  subscribe.mockReturnValue({ unsubscribe });
});
afterEach(() => vi.useRealTimers());

describe('Channel snapshot subscription lifecycle', () => {
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
});

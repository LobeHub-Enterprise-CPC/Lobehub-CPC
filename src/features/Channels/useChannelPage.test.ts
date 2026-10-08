import { act, renderHook, waitFor } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { createElement } from 'react';
import { SWRConfig } from 'swr';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { channelService } from '@/services/channel';

import { useChannelPage } from './useChannelPage';

vi.mock('@/services/channel', () => ({ channelService: { detail: vi.fn(), watch: vi.fn() } }));

function wrapper() {
  const cache = new Map();
  return function SWRTestWrapper({ children }: PropsWithChildren) {
    return createElement(
      SWRConfig,
      {
        value: {
          provider: () => cache,
          dedupingInterval: 0,
          revalidateOnFocus: false,
          shouldRetryOnError: false,
        },
      },
      children,
    );
  };
}

const page = (channelId: string, before?: number, threadId: string | null = null) =>
  ({
    channel: { id: channelId },
    before,
    threadId,
    messages: [{ id: `message-${before ?? 100}` }],
    nextCursor: before === undefined ? 50 : null,
  }) as Awaited<ReturnType<typeof channelService.detail>>;

beforeEach(() => {
  vi.mocked(channelService.detail)
    .mockReset()
    .mockImplementation(async (channelId, options) =>
      page(channelId, options?.before, options?.threadId ?? null),
    );
  vi.mocked(channelService.watch).mockReset().mockReturnValue({ unsubscribe: vi.fn() });
});

describe('Channel message page lifecycle', () => {
  it('keeps the selected older window during live updates and returns to the latest page', async () => {
    const { result, unmount } = renderHook(() => useChannelPage('one', null), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current.data?.channel.id).toBe('one'));
    act(() => result.current.pagination.older());
    await waitFor(() => expect(result.current.data?.before).toBe(50));
    expect(result.current.pagination.hasNewer).toBe(true);
    act(() =>
      vi
        .mocked(channelService.watch)
        .mock.calls.at(-1)![1]({ revision: 'changed', navigationRevision: 'nav' }),
    );
    await waitFor(() =>
      expect(channelService.detail).toHaveBeenLastCalledWith('one', { before: 50, threadId: null }),
    );
    expect(result.current.data?.before).toBe(50);
    act(() => result.current.pagination.newer());
    await waitFor(() => expect(result.current.data?.before).toBeUndefined());
    expect(result.current.pagination.hasNewer).toBe(false);
    unmount();
  });

  it('retains settled content after a failed page request and retries the requested cursor', async () => {
    const { result, unmount } = renderHook(() => useChannelPage('one', null), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current.data).toBeDefined());
    vi.mocked(channelService.detail).mockRejectedValueOnce(new Error('Network failure'));
    act(() => result.current.pagination.older());
    await waitFor(() => expect(result.current.error).toBeDefined());
    expect(result.current.data?.messages).toEqual(page('one').messages);
    expect(result.current.pagination.hasOlder).toBe(false);
    await act(async () => {
      await result.current.mutate();
    });
    expect(result.current.data?.before).toBe(50);
    expect(result.current.error).toBeUndefined();
    unmount();
  });

  it('resets pagination and never shows the previous Channel or Thread while changing scopes', async () => {
    const { result, rerender, unmount } = renderHook(
      ({ channelId, threadId }: { channelId: string; threadId: string | null }) =>
        useChannelPage(channelId, threadId),
      { initialProps: { channelId: 'one', threadId: null as string | null }, wrapper: wrapper() },
    );
    await waitFor(() => expect(result.current.data).toBeDefined());
    act(() => result.current.pagination.older());
    await waitFor(() => expect(result.current.data?.before).toBe(50));
    let resolve!: (value: Awaited<ReturnType<typeof channelService.detail>>) => void;
    vi.mocked(channelService.detail).mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    rerender({ channelId: 'two', threadId: 'thread' });
    expect(result.current.data).toBeUndefined();
    expect(result.current.pagination.hasNewer).toBe(false);
    await act(async () => {
      resolve(page('two', undefined, 'thread'));
    });
    expect(result.current.data?.channel.id).toBe('two');
    expect(result.current.data?.threadId).toBe('thread');
    unmount();
  });

  it('does not query or subscribe before Channel availability is enabled', () => {
    const { unmount } = renderHook(() => useChannelPage('one', null, false), {
      wrapper: wrapper(),
    });
    expect(channelService.detail).not.toHaveBeenCalled();
    expect(channelService.watch).not.toHaveBeenCalled();
    unmount();
  });

  it('unsubscribes from an open Channel when access is switched off', async () => {
    const unsubscribe = vi.fn();
    vi.mocked(channelService.watch).mockReturnValue({ unsubscribe });
    const { result, rerender, unmount } = renderHook(
      ({ enabled }) => useChannelPage('one', null, enabled),
      { initialProps: { enabled: true }, wrapper: wrapper() },
    );
    await waitFor(() => expect(result.current.data?.channel.id).toBe('one'));
    vi.mocked(channelService.detail).mockClear();
    vi.mocked(channelService.watch).mockClear();

    rerender({ enabled: false });
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(channelService.detail).not.toHaveBeenCalled();
    expect(channelService.watch).not.toHaveBeenCalled();
    unmount();
  });
});

import { CHANNEL_PRESENCE } from '@lobechat/types';
import { useEffect, useRef, useState } from 'react';
import useSWR, { useSWRConfig } from 'swr';

import { channelService } from '@/services/channel';

/** A fixed message window keeps both database reads and rendered chat rows bounded. */
export function useChannelPage(
  channelId: string | undefined,
  threadId: string | null,
  enabled = true,
) {
  const scope = `${channelId}:${threadId ?? 'main'}`;
  const [history, setHistory] = useState<{ scope: string; cursors: number[] }>({
    scope,
    cursors: [],
  });
  if (history.scope !== scope) setHistory({ scope, cursors: [] });
  const cursors = history.scope === scope ? history.cursors : [];
  const before = cursors.at(-1);
  const [liveScope, setLiveScope] = useState<string>();
  const navigationRevision = useRef<string | undefined>(undefined);
  const { mutate: refreshCache } = useSWRConfig();
  const key =
    before === undefined && threadId === null
      ? ['channel', channelId]
      : ['channel-page', channelId, threadId, before];
  const {
    data: cached,
    error,
    isLoading,
    mutate,
  } = useSWR(
    enabled && channelId ? key : null,
    () => channelService.detail(channelId!, { before, threadId }),
    {
      keepPreviousData: true,
      refreshInterval: () => (liveScope === scope ? 0 : CHANNEL_PRESENCE.fallbackMs),
      refreshWhenHidden: false,
    },
  );
  const data =
    cached && cached.channel.id === channelId && cached.threadId === threadId ? cached : undefined;
  useEffect(() => {
    if (!enabled || !channelId) return;
    const subscription = channelService.watch(
      channelId,
      (update) => {
        void mutate();
        if (navigationRevision.current !== update.navigationRevision) {
          navigationRevision.current = update.navigationRevision;
          void refreshCache('channels');
        }
      },
      (healthy) => {
        setLiveScope(healthy ? scope : undefined);
        if (!healthy && document.visibilityState !== 'hidden') void mutate();
      },
    );
    return () => subscription.unsubscribe();
  }, [channelId, enabled, mutate, refreshCache, scope]);

  return {
    data,
    error,
    mutate,
    pagination: {
      hasOlder: data?.before === before && data?.nextCursor != null,
      hasNewer: cursors.length > 0,
      isLoading,
      pageKey: `${scope}:${data?.before ?? 'latest'}`,
      older: () => {
        if (!isLoading && data?.before === before && data?.nextCursor != null)
          setHistory({ scope, cursors: [...cursors, data.nextCursor] });
      },
      newer: () => setHistory({ scope, cursors: cursors.slice(0, -1) }),
      latest: () => setHistory({ scope, cursors: [] }),
    },
  };
}

export type ChannelPagination = ReturnType<typeof useChannelPage>['pagination'];

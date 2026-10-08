import { setTimeout as delay } from 'node:timers/promises';

import { CHANNEL_PRESENCE } from '@lobechat/types';

import type { ChannelModel } from '@/database/models/channel';

type Revision = Awaited<ReturnType<ChannelModel['revision']>>;
interface SharedSnapshot {
  expires: number;
  pending?: Promise<Revision>;
  readers: number;
}
const snapshots = new Map<string, SharedSnapshot>();

/** Share DB sampling and serialization across this owner's tabs, not across owners. */
export async function* watchChannel(
  key: string,
  load: () => Promise<Revision>,
  signal?: AbortSignal,
) {
  let state = snapshots.get(key);
  if (!state) {
    state = { expires: 0, readers: 0 };
    snapshots.set(key, state);
  }
  state.readers++;
  let previous = '';
  const deadline = Date.now() + CHANNEL_PRESENCE.streamMs;
  try {
    while (!signal?.aborted && Date.now() < deadline) {
      if (!state.pending || Date.now() >= state.expires) {
        state.expires = Infinity;
        state.pending = load().then((data) => {
          state!.expires = Date.now() + CHANNEL_PRESENCE.snapshotMs;
          return data;
        });
      }
      const data = await state.pending;
      if (data.revision !== previous) {
        previous = data.revision;
        yield data;
      }
      await delay(CHANNEL_PRESENCE.snapshotMs, undefined, { signal }).catch((error) => {
        if (!signal?.aborted) throw error;
      });
    }
  } finally {
    if (--state.readers === 0) snapshots.delete(key);
  }
}

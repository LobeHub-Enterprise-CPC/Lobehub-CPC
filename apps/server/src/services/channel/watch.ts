import { setTimeout as delay } from 'node:timers/promises';

import { currentTenantScope } from '@lobechat/database/tenant';
import { CHANNEL_PRESENCE } from '@lobechat/types';

import type { ChannelModel } from '@/database/models/channel';

type Revision = Awaited<ReturnType<ChannelModel['revision']>>;
interface SharedSnapshot {
  expires: number;
  pending?: Promise<Revision>;
  readers: number;
}
const snapshots = new Map<string, SharedSnapshot>();

/**
 * Share DB sampling and serialization across this owner's tabs, not across owners.
 * The snapshot is the tenant database's data, so the tenant is part of the owner:
 * identical `owner:channel` ids in two tenants must never share a snapshot.
 */
export async function* watchChannel(
  ownerKey: string,
  load: () => Promise<Revision>,
  signal?: AbortSignal,
) {
  const key = `${currentTenantScope()?.tenantId ?? ''}|${ownerKey}`;
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

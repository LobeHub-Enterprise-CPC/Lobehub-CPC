import { RedisKeys } from '@/server/modules/Redis';

import { getRedisServiceClient } from './client';

const getClient = () => getRedisServiceClient('agentRuntime');

/** Comfortably longer than the sweep interval; past it the next sweep starts over. */
const CURSOR_TTL_SECONDS = 15 * 60;

/**
 * The stale-operation reaper's scan position (an opaque serialized value owned
 * by the reaper). Losing it only restarts the scan from the oldest candidate,
 * so reads return `null` and writes are skipped without Redis.
 */
export const staleSweepCursor = {
  async load(): Promise<string | null> {
    const redis = await getClient();
    if (!redis) return null;
    return redis.get(RedisKeys.agentRuntime.staleSweepCursor());
  },

  /** `null` clears the position: the scan reached its end and wraps around. */
  async save(position: string | null): Promise<void> {
    const redis = await getClient();
    if (!redis) return;
    const key = RedisKeys.agentRuntime.staleSweepCursor();
    if (position === null) {
      await redis.del(key);
      return;
    }
    await redis.set(key, position, { ex: CURSOR_TTL_SECONDS });
  },
};

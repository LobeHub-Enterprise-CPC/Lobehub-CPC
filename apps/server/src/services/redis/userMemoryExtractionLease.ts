import { RedisKeys } from '@/server/modules/Redis';

import { getRedisServiceClient } from './client';

const getClient = () => getRedisServiceClient('userMemory');

/**
 * How long a lease outlives a run that never released it. A run is bounded by its per-run topic
 * ceiling well below this.
 */
const LEASE_TTL_SECONDS = 3 * 60 * 60;

/** KEYS[1] = lease; ARGV[1] = owner. Releases only the caller's own lease. */
const RELEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0
`;

/**
 * One memory extraction run per user at a time. Hourly fan-out would otherwise start a second
 * run for a user whose previous one is still working, both extracting the same topics; and
 * identity memories are added, updated and removed, so two runs must not interleave them.
 *
 * Without Redis every run holds the lease: extraction goes on uncoordinated rather than stopping.
 */
export const userMemoryExtractionLease = {
  /** Takes the user's lease for `runId`; true when it holds it, including already holding it. */
  async acquire(userId: string, runId: string): Promise<boolean> {
    const redis = await getClient();
    if (!redis) return true;

    const key = RedisKeys.userMemory.extractionRunLease(userId);
    try {
      if ((await redis.set(key, runId, { ex: LEASE_TTL_SECONDS, nx: true })) === 'OK') return true;
      return (await redis.get(key)) === runId;
    } catch {
      return true;
    }
  },

  /** Best effort: a lease that cannot be released lapses on its own. */
  async release(userId: string, runId: string): Promise<void> {
    const redis = await getClient();
    if (!redis) return;

    await redis
      .eval(RELEASE_SCRIPT, 1, RedisKeys.userMemory.extractionRunLease(userId), runId)
      .catch(() => undefined);
  },
};

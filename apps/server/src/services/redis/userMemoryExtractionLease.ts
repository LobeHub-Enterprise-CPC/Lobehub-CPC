import { RedisKeys } from '@/server/modules/Redis';

import { getRedisServiceClient } from './client';

const getClient = () => getRedisServiceClient('userMemory');

/**
 * How long a lease outlives a run that never released it. A working run extends it before every
 * segment (`hold`), since a run over a long backlog with a slow model can outlast it.
 */
const LEASE_TTL_SECONDS = 3 * 60 * 60;

/**
 * KEYS[1] = lease; ARGV[1] = owner; ARGV[2] = ttl seconds. Extends the caller's lease, or takes it
 * again if it lapsed; fails only when another run holds it.
 */
const HOLD_SCRIPT = `
local holder = redis.call('GET', KEYS[1])
if holder == ARGV[1] then return redis.call('EXPIRE', KEYS[1], ARGV[2]) end
if not holder then redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2]) return 1 end
return 0
`;

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

  /**
   * Keeps the lease of a run still working: extends it, or takes it again if it lapsed. False
   * once another run has taken the user over, which a run longer than the TTL would otherwise
   * not notice and go on extracting the same topics as that run.
   */
  async hold(userId: string, runId: string): Promise<boolean> {
    const redis = await getClient();
    if (!redis) return true;

    try {
      const held = await redis.eval(
        HOLD_SCRIPT,
        1,
        RedisKeys.userMemory.extractionRunLease(userId),
        runId,
        String(LEASE_TTL_SECONDS),
      );
      return Number(held) === 1;
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

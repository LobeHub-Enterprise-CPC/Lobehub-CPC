import Redis from 'ioredis';

import { getRedisConfig } from '@/envs/redis';
import { isRedisEnabled, tenantRedisPrefix } from '@/server/modules/Redis';

/** Keys deleted per round trip; SCAN returns pages of about this size. */
const BATCH = 500;

/**
 * A dedicated, unprefixed connection: a tenant's keys sit under `t:{tenantId}:` right after each
 * client's own prefix (`{REDIS_PREFIX}:`, namespaces such as `aiGeneration:`) or at the root for
 * the agent runtime, so only an unprefixed SCAN reaches all of them. Agent runtime and cache share
 * the server and database (`REDIS_URL`, `REDIS_DATABASE`).
 */
const connect = () => {
  const config = getRedisConfig();
  if (!isRedisEnabled(config)) return;
  return new Redis(config.url, {
    commandTimeout: 30_000,
    connectTimeout: 10_000,
    db: config.database,
    lazyConnect: true,
    maxRetriesPerRequest: 2,
    password: config.password,
    tls: config.tls ? {} : undefined,
    username: config.username,
  });
};

export const tenantResidue = {
  /**
   * Deletes every key a destroyed tenant left in Redis (cache and agent runtime state) and returns
   * how many it deleted. Repeatable: a rerun deletes what is left. Rejects when Redis cannot be
   * reached, so the destruction phase stays open and is repeated.
   */
  purge: async (tenantId: string): Promise<number> => {
    const segment = tenantRedisPrefix(tenantId);
    const redis = connect();
    if (!redis) return 0;
    let deleted = 0;
    try {
      await redis.connect();
      let cursor = '0';
      do {
        const [next, keys] = await redis.scan(cursor, 'MATCH', `*${segment}*`, 'COUNT', BATCH);
        cursor = next;
        // MATCH is a glob: keep only keys whose segment starts at the root or right after a ':'.
        const mine = keys.filter((key) => key.startsWith(segment) || key.includes(`:${segment}`));
        if (mine.length) deleted += await redis.unlink(...mine);
      } while (cursor !== '0');
    } finally {
      redis.disconnect();
    }
    return deleted;
  },
};

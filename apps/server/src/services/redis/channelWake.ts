import { currentTenantScope } from '@lobechat/database/tenant';
import debug from 'debug';
import Redis from 'ioredis';

import { getRedisConfig } from '@/envs/redis';
import { isRedisEnabled, TENANT_REDIS_SEGMENT, tenantRedisPrefix } from '@/server/modules/Redis';

const log = debug('lobe-server:redis:channel-wake');

/**
 * Wake signal from the Web side to the channel coordinator (scripts/channel-worker.ts).
 *
 * The persisted message or job is the source of truth; the signal only makes an idle
 * tenant due on the coordinator's next round instead of after its backoff. Pub/Sub
 * channels ignore ioredis key prefixes and database numbers, so the channel name
 * carries the deployment prefix and the tenant keyspace segment itself:
 * `{REDIS_PREFIX}:t:{tenantId}:channel:wake`.
 */
const WAKE_SUFFIX = 'channel:wake';
const tenantSegment = (prefix: string) => `${prefix}:${TENANT_REDIS_SEGMENT}:`;

const tenantOf = (prefix: string, channel: string) => {
  const head = tenantSegment(prefix);
  const tail = `:${WAKE_SUFFIX}`;
  if (!channel.startsWith(head) || !channel.endsWith(tail)) return;
  try {
    return decodeURIComponent(channel.slice(head.length, -tail.length)) || undefined;
  } catch {
    return;
  }
};

/** A dedicated connection: Pub/Sub needs its own (a subscribed one runs nothing else). */
const connect = () => {
  const config = getRedisConfig();
  if (!isRedisEnabled(config)) return;
  const redis = new Redis(config.url, {
    commandTimeout: 10_000,
    connectTimeout: 10_000,
    db: config.database,
    maxRetriesPerRequest: 2,
    password: config.password,
    tls: config.tls ? {} : undefined,
    username: config.username,
  });
  // Reconnection is automatic; a missed signal is covered by the coordinator's backoff.
  redis.on('error', (error) => log('connection error: %s', error.message));
  return { prefix: config.prefix, redis };
};

let publisher: ReturnType<typeof connect> | null = null;

const describeError = (error: unknown) => (error instanceof Error ? error.message : String(error));

export const channelWake = {
  /**
   * Tells the channel coordinator that the current tenant committed Channel work. Call it
   * after the transaction has committed. Best effort: it never rejects, because the
   * coordinator still enters every idle tenant within 30 s without it.
   */
  async wake(): Promise<void> {
    const tenantId = currentTenantScope()?.tenantId;
    if (!tenantId) return;
    try {
      publisher ??= connect();
      if (!publisher) return;
      await publisher.redis.publish(
        `${publisher.prefix}:${tenantRedisPrefix(tenantId)}${WAKE_SUFFIX}`,
        JSON.stringify({ tenantId }),
      );
    } catch (error) {
      console.warn(
        `[channel] Wake for tenant ${tenantId} not delivered; the worker falls back to polling:`,
        describeError(error),
      );
    }
  },

  /**
   * Subscribes the coordinator to every tenant's wake signal. Returns the closer, or
   * nothing when Redis is not configured (the coordinator then relies on its backoff).
   */
  subscribe(onWake: (tenantId: string) => void): (() => void) | undefined {
    const connection = connect();
    if (!connection) return;
    const { prefix, redis } = connection;
    const pattern = `${tenantSegment(prefix)}*:${WAKE_SUFFIX}`;
    // Subscribe on every (re)connection: a subscription that failed while Redis was
    // unreachable is not restored by ioredis on its own.
    redis.on('ready', () => {
      redis
        .psubscribe(pattern)
        .catch((error: unknown) =>
          console.warn(
            '[channel-worker] Wake subscription failed; idle tenants fall back to polling:',
            describeError(error),
          ),
        );
    });
    redis.on('pmessage', (_pattern: string, channel: string) => {
      const tenantId = tenantOf(prefix, channel);
      if (tenantId) onWake(tenantId);
    });
    return () => redis.disconnect();
  },
};

import type { BaseRedisProvider } from '@/server/modules/Redis/types';

import { getSharedRedisServiceClient } from './client';

/**
 * Messaging runtime state that is not tenant-scoped: the webhook reconcile
 * cooldown, the key sweep when an installation is relinked, and the client the
 * Chat SDK state adapter requires. Keys are composed by the caller and stay
 * inside the messaging namespaces; nothing here reaches another domain.
 */
export const messenger = {
  /**
   * Claim a slot for `ttlSeconds`. `null` means Redis is unavailable, so the
   * caller falls back to its in-process map instead of reading `false` as
   * "someone else holds it".
   */
  async acquireCooldown(key: string, ttlSeconds: number): Promise<boolean | null> {
    const redis = await getSharedRedisServiceClient();
    if (!redis) return null;

    const result = await redis.set(key, '1', 'EX', ttlSeconds, 'NX');
    return result === 'OK';
  },

  /** Drop the keys an installation owned before its credentials were replaced. */
  async deleteKeys(...keys: string[]): Promise<void> {
    const redis = await getSharedRedisServiceClient();
    if (!redis) return;

    await redis.del(...keys);
  },

  /** The Chat SDK state adapter needs the provider client itself. */
  async getStateClient(): Promise<BaseRedisProvider | null> {
    return getSharedRedisServiceClient();
  },
};

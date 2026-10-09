import { currentTenantScope, requireTenantScope } from '@lobechat/database/tenant';
import debug from 'debug';

import { getRedisConfig } from '@/envs/redis';
import { initializeRedis, initializeSharedRedis } from '@/libs/redis';

import type {
  RuntimeConfigDomain,
  RuntimeConfigProvider,
  RuntimeConfigSelector,
  VersionedSnapshot,
} from '../types';

const log = debug('lobe:runtime-config');

interface CacheRecord<T> {
  expiresAt: number;
  snapshot: VersionedSnapshot<T> | null;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isVersionedSnapshotEnvelope = (value: unknown): value is VersionedSnapshot<unknown> => {
  if (!isObject(value)) return false;

  return 'data' in value && 'updatedAt' in value && 'version' in value;
};

export class RedisRuntimeConfigProvider<T> implements RuntimeConfigProvider<T> {
  private cache = new Map<string, CacheRecord<T>>();
  private nextExpiredEntryAt = Number.POSITIVE_INFINITY;

  constructor(public domain: RuntimeConfigDomain<T>) {}

  isEnabled() {
    return getRedisConfig().enabled;
  }

  private getCacheKey(selector?: RuntimeConfigSelector) {
    const key =
      !selector || selector.scope === 'global' ? 'global' : `${selector.scope}:${selector.id}`;

    // Tenant snapshots are cached per tenant, like their Redis keys.
    return this.domain.shared ? key : `${requireTenantScope().tenantId}:${key}`;
  }

  private evictExpiredEntriesIfNeeded(now: number) {
    if (this.cache.size === 0) {
      this.nextExpiredEntryAt = Number.POSITIVE_INFINITY;
      return;
    }

    if (now < this.nextExpiredEntryAt) return;

    let nextExpiredEntryAt = Number.POSITIVE_INFINITY;

    for (const [key, record] of this.cache) {
      if (record.expiresAt <= now) {
        this.cache.delete(key);
        continue;
      }

      if (record.expiresAt < nextExpiredEntryAt) {
        nextExpiredEntryAt = record.expiresAt;
      }
    }

    this.nextExpiredEntryAt = nextExpiredEntryAt;
  }

  private getCacheRecord(selector?: RuntimeConfigSelector) {
    const now = Date.now();
    this.evictExpiredEntriesIfNeeded(now);

    const record = this.cache.get(this.getCacheKey(selector));
    if (!record) return null;

    return record;
  }

  private setCacheRecord(snapshot: VersionedSnapshot<T> | null, selector?: RuntimeConfigSelector) {
    const expiresAt = Date.now() + this.domain.cacheTtlMs;

    this.cache.set(this.getCacheKey(selector), {
      expiresAt,
      snapshot,
    });

    if (expiresAt < this.nextExpiredEntryAt) {
      this.nextExpiredEntryAt = expiresAt;
    }
  }

  private resolveEnvelopeData(raw: string): VersionedSnapshot<T> | null {
    let parsed: unknown;

    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      console.error('[RuntimeConfig] Failed to parse snapshot payload from Redis:', error);
      return null;
    }

    if (isVersionedSnapshotEnvelope(parsed)) {
      const result = this.domain.schema.safeParse(parsed.data);

      if (!result.success) {
        log('[RuntimeConfig] Domain %s schema validation failed', this.domain.key, result.error);
        return null;
      }

      return {
        data: result.data,
        updatedAt: String(parsed.updatedAt),
        version: Number(parsed.version) || 0,
      };
    }

    const result = this.domain.schema.safeParse(parsed);

    if (!result.success) {
      log('[RuntimeConfig] Domain %s schema validation failed', this.domain.key, result.error);
      return null;
    }

    return {
      data: result.data,
      updatedAt: new Date().toISOString(),
      version: 0,
    };
  }

  async getSnapshot(selector?: RuntimeConfigSelector): Promise<VersionedSnapshot<T> | null> {
    // A tenant snapshot has no meaning outside a tenant.
    if (!this.domain.shared && !currentTenantScope()) return null;

    const cached = this.getCacheRecord(selector);
    if (cached) return cached.snapshot;

    try {
      const redis = this.domain.shared
        ? await initializeSharedRedis(getRedisConfig())
        : await initializeRedis(getRedisConfig());
      if (!redis) return null;

      const key = this.domain.getStorageKey(selector);
      const raw = await redis.get(key);

      if (!raw) {
        if (this.domain.cacheNullSnapshots !== false) {
          this.setCacheRecord(null, selector);
        }
        return null;
      }

      const envelope = this.resolveEnvelopeData(raw);
      this.setCacheRecord(envelope, selector);
      return envelope;
    } catch (error) {
      console.error('[RuntimeConfig] Failed to read runtime config from Redis:', error);
      return null;
    }
  }
}

import { requireTenantScope } from '@lobechat/database/tenant';

import {
  type BaseRedisProvider,
  type RedisKey,
  type RedisMSetArgument,
  type RedisPipeline,
  type RedisScanArgs,
  type RedisScanResult,
  type RedisSetResult,
  type RedisValue,
  type SetOptions,
} from './types';
import { normalizeMsetValues, normalizeRedisKey } from './utils';

/**
 * Redis keyspace per tenant (spec FR-AS-05). Every key a client writes or
 * reads is `t:{tenantId}:{key}`, after the deployment prefix the connection
 * already applies (`{REDIS_PREFIX}:` or a namespace such as `aiGeneration:`),
 * so the full key is `{prefix}:t:{tenantId}:{key}`.
 *
 * Data that really belongs to the deployment (published feature flags) lives
 * under the reserved tenant segment `_shared`. Clearing one tenant's cache is
 * `SCAN {prefix}:t:{tenantId}:*` and a batch delete.
 */
export const TENANT_REDIS_SEGMENT = 't';
export const SHARED_REDIS_TENANT = '_shared';

export const tenantRedisPrefix = (tenantId: string) => {
  if (!tenantId || tenantId.includes(':') || tenantId.includes('*')) {
    throw new Error('TENANT_REDIS_KEY_INVALID');
  }
  return `${TENANT_REDIS_SEGMENT}:${tenantId}:`;
};

/** The current tenant's key prefix; fails closed outside a tenant. */
export const currentTenantRedisPrefix = () => tenantRedisPrefix(requireTenantScope().tenantId);

export const sharedRedisPrefix = () => tenantRedisPrefix(SHARED_REDIS_TENANT);

/**
 * A client whose keys are confined to one prefix, resolved on every command
 * (the current tenant's, for the default clients). A holder that caches the
 * client still reaches only the tenant of the request that runs the command.
 */
export class PrefixedRedisClient implements BaseRedisProvider {
  constructor(
    private readonly base: BaseRedisProvider,
    private readonly resolvePrefix: () => string,
  ) {}

  private k(key: RedisKey) {
    return `${this.resolvePrefix()}${normalizeRedisKey(key)}`;
  }

  private ks(keys: RedisKey[]) {
    const prefix = this.resolvePrefix();
    return keys.map((key) => `${prefix}${normalizeRedisKey(key)}`);
  }

  initialize() {
    return this.base.initialize();
  }

  disconnect() {
    return this.base.disconnect();
  }

  get(key: RedisKey) {
    return this.base.get(this.k(key));
  }

  set(key: RedisKey, value: RedisValue, options?: SetOptions): Promise<RedisSetResult> {
    return this.base.set(this.k(key), value, options);
  }

  setex(key: RedisKey, seconds: number, value: RedisValue) {
    return this.base.setex(this.k(key), seconds, value);
  }

  del(...keys: RedisKey[]) {
    return this.base.del(...this.ks(keys));
  }

  exists(...keys: RedisKey[]) {
    return this.base.exists(...this.ks(keys));
  }

  expire(key: RedisKey, seconds: number) {
    return this.base.expire(this.k(key), seconds);
  }

  ttl(key: RedisKey) {
    return this.base.ttl(this.k(key));
  }

  incr(key: RedisKey) {
    return this.base.incr(this.k(key));
  }

  decr(key: RedisKey) {
    return this.base.decr(this.k(key));
  }

  mget(...keys: RedisKey[]) {
    return this.base.mget(...this.ks(keys));
  }

  mset(values: RedisMSetArgument) {
    const prefix = this.resolvePrefix();
    const prefixed: Record<string, RedisValue> = {};
    for (const [key, value] of Object.entries(normalizeMsetValues(values))) {
      prefixed[`${prefix}${key}`] = value;
    }
    return this.base.mset(prefixed);
  }

  hget(key: RedisKey, field: RedisKey) {
    return this.base.hget(this.k(key), field);
  }

  hset(key: RedisKey, field: RedisKey, value: RedisValue) {
    return this.base.hset(this.k(key), field, value);
  }

  hdel(key: RedisKey, ...fields: RedisKey[]) {
    return this.base.hdel(this.k(key), ...fields);
  }

  hgetall(key: RedisKey) {
    return this.base.hgetall(this.k(key));
  }

  /** The first `numkeys` arguments are keys (Redis EVAL convention). */
  eval<T = unknown>(script: string, numkeys: number, ...args: RedisValue[]): Promise<T> {
    const prefix = this.resolvePrefix();
    const prefixed = args.map((arg, index) => (index < numkeys ? `${prefix}${String(arg)}` : arg));
    return this.base.eval<T>(script, numkeys, ...prefixed);
  }

  /** MATCH is confined to the prefix (default `*`); keys come back without it. */
  async scan(cursor: string, ...args: RedisScanArgs): Promise<RedisScanResult> {
    const prefix = this.resolvePrefix();
    let match = '*';
    let count: number | undefined;
    for (let i = 0; i < args.length; i += 2) {
      if (args[i] === 'MATCH') match = String(args[i + 1]);
      if (args[i] === 'COUNT') count = Number(args[i + 1]);
    }

    const [next, keys] =
      count === undefined
        ? await this.base.scan(cursor, 'MATCH', `${prefix}${match}`)
        : await this.base.scan(cursor, 'MATCH', `${prefix}${match}`, 'COUNT', count);

    return [next, keys.map((key) => (key.startsWith(prefix) ? key.slice(prefix.length) : key))];
  }

  pipeline(): RedisPipeline {
    const raw = this.base.pipeline();
    const prefix = this.resolvePrefix();
    const k = (key: RedisKey) => `${prefix}${normalizeRedisKey(key)}`;
    const pipe: RedisPipeline = {
      decr: (key) => (raw.decr(k(key)), pipe),
      del: (...keys) => (raw.del(...keys.map(k)), pipe),
      exec: () => raw.exec(),
      expire: (key, seconds) => (raw.expire(k(key), seconds), pipe),
      get: (key) => (raw.get(k(key)), pipe),
      hdel: (key, ...fields) => (raw.hdel(k(key), ...fields), pipe),
      hget: (key, field) => (raw.hget(k(key), field), pipe),
      hgetall: (key) => (raw.hgetall(k(key)), pipe),
      hset: (key, field, value) => (raw.hset(k(key), field, value), pipe),
      incr: (key) => (raw.incr(k(key)), pipe),
      set: (key, value, options) => (raw.set(k(key), value, options), pipe),
      setex: (key, seconds, value) => (raw.setex(k(key), seconds, value), pipe),
    };
    return pipe;
  }
}

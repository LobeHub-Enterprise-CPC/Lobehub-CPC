import { requireTenantScope } from '@lobechat/database/tenant';
import debug from 'debug';
import Redis, { type RedisOptions } from 'ioredis';

import { redisEnv } from '@/envs/redis';
import { isRedisDisabledByEnv } from '@/libs/redis';

const log = debug('lobe-server:agent-runtime:redis');
const timing = debug('lobe-server:agent-runtime:timing');

/**
 * Get Redis URL from environment
 */
const getRedisUrl = (): string | undefined => {
  return redisEnv.REDIS_URL;
};

/**
 * Get Redis connection description for logging (hide sensitive parts)
 */
const getRedisConnectionDescription = (url: string): string => {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return 'redis://***';
  }
};

/**
 * Create Redis client instance for Agent Runtime
 */
export const createAgentRuntimeRedisClient = (
  url?: string,
  options: Pick<RedisOptions, 'keyPrefix'> = {},
): Redis | null => {
  if (isRedisDisabledByEnv()) return null;

  const redisUrl = url || getRedisUrl();

  if (!redisUrl) {
    console.warn(
      '[Agent Runtime Redis] No Redis URL available. Agent Runtime features are disabled.',
    );
    return null;
  }

  const createStart = Date.now();
  timing('Redis client creating at %d', createStart);

  const client = new Redis(redisUrl, {
    ...options,
    maxRetriesPerRequest: 3,
  });

  client.on('connect', () => {
    const connectTime = Date.now();
    log('Connected to Redis: %s', getRedisConnectionDescription(redisUrl));
    timing(
      'Redis connected at %d, took %dms from creation',
      connectTime,
      connectTime - createStart,
    );
  });

  client.on('ready', () => {
    const readyTime = Date.now();
    timing('Redis ready at %d, took %dms from creation', readyTime, readyTime - createStart);
  });

  client.on('error', (error) => {
    console.error('[Agent Runtime Redis] Redis connection error:', error);
  });

  client.on('close', () => {
    log('Redis connection closed');
  });

  return client;
};

/**
 * Agent runtime keys live in the tenant's keyspace `t:{tenantId}:` (spec
 * FR-AS-05). Each tenant gets its own connection whose ioredis `keyPrefix`
 * prefixes every key argument, including stream, Lua (`KEYS[]`) and
 * pipeline/multi commands; `duplicate()` keeps the prefix. KEYS/SCAN
 * patterns are confined to the prefix here, since ioredis leaves them as is.
 */
const TENANT_KEY_SEGMENT = 't';

export const agentRuntimeTenantKeyPrefix = (tenantId: string) => {
  if (!tenantId || tenantId.includes(':') || tenantId.includes('*')) {
    throw new Error('TENANT_REDIS_KEY_INVALID');
  }
  return `${TENANT_KEY_SEGMENT}:${tenantId}:`;
};

const tenantClients = new Map<string, Redis>();
let redisEnabled: boolean | undefined;

const tenantClient = (tenantId: string): Redis | null => {
  const existing = tenantClients.get(tenantId);
  if (existing) return existing;

  const keyPrefix = agentRuntimeTenantKeyPrefix(tenantId);
  const client = createAgentRuntimeRedisClient(undefined, { keyPrefix });
  if (!client) return null;

  // KEYS/SCAN patterns are not prefixed by ioredis, and the keys they return
  // carry the prefix: confine the pattern and strip the prefix.
  const keys = client.keys.bind(client);
  client.keys = (async (pattern: string) => {
    const found: string[] = await keys(`${keyPrefix}${pattern}`);
    return found.map((key) => (key.startsWith(keyPrefix) ? key.slice(keyPrefix.length) : key));
  }) as Redis['keys'];

  tenantClients.set(tenantId, client);
  return client;
};

/**
 * Whether the agent runtime has Redis, without touching a tenant keyspace.
 */
export const isAgentRuntimeRedisEnabled = (): boolean => {
  if (redisEnabled === undefined) redisEnabled = !isRedisDisabledByEnv() && !!getRedisUrl();
  return redisEnabled;
};

/**
 * The current tenant's agent runtime Redis client (fails closed outside a
 * tenant). Holders may keep the returned client: every command is routed to
 * the tenant of the scope it runs in.
 */
export function getAgentRuntimeRedisClient(): Redis | null {
  if (!isAgentRuntimeRedisEnabled()) return null;

  // Resolve the tenant now, so a call outside a tenant fails here.
  requireTenantScope();

  return new Proxy({} as Redis, {
    get(_target, prop) {
      const client = tenantClient(requireTenantScope().tenantId);
      if (!client) return undefined;
      const value = Reflect.get(client, prop, client);
      return typeof value === 'function' ? value.bind(client) : value;
    },
  });
}

/**
 * Close every tenant's agent runtime Redis connection
 */
export async function closeAgentRuntimeRedisClient(): Promise<void> {
  const clients = [...tenantClients.values()];
  tenantClients.clear();
  redisEnabled = undefined;
  await Promise.all(clients.map((client) => client.quit()));
}

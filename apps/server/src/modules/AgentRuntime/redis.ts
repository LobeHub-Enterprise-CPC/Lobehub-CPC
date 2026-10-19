import { requireTenantScope } from '@lobechat/database/tenant';
import debug from 'debug';
import Redis, { type RedisOptions } from 'ioredis';

import { redisEnv } from '@/envs/redis';
import { isRedisDisabledByEnv } from '@/server/modules/Redis';

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
 * Connection options from the shared Redis env, applied the way the main
 * provider (`IoRedisRedisProvider`) applies them. ioredis lets values already
 * in the URL win, so `redis://user:pass@host/1` keeps working.
 */
const getRedisEnvConnectionOptions = (): RedisOptions => ({
  db: redisEnv.REDIS_DATABASE,
  password: redisEnv.REDIS_PASSWORD,
  tls: redisEnv.REDIS_TLS ? {} : undefined,
  username: redisEnv.REDIS_USERNAME,
});

/**
 * Create Redis client instance for Agent Runtime.
 *
 * Without an explicit `url` the client targets the env-configured server and
 * also uses its credentials/db/TLS. An explicit `url` is self-contained: the
 * env credentials belong to the env server and are not sent to another host.
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
    ...(url ? {} : getRedisEnvConnectionOptions()),
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
  if (!/^[A-Z0-9][\w.:-]{0,127}$/i.test(tenantId)) throw new Error('TENANT_REDIS_KEY_INVALID');
  return `${TENANT_KEY_SEGMENT}:${encodeURIComponent(tenantId)}:`;
};

interface TenantRedisClient {
  client: Redis;
  lastUsed: number;
  pending: number;
}
const tenantClients = new Map<string, TenantRedisClient>();
const MAX_TENANT_CLIENTS = 128;
const IDLE_CLIENT_MS = 60_000;
let idleSweep: ReturnType<typeof setInterval> | undefined;
const retireClient = (tenantId: string, entry: TenantRedisClient) => {
  tenantClients.delete(tenantId);
  // There are no pending business commands. Disconnect immediately so a stalled
  // Redis server cannot accumulate unbounded sockets waiting for QUIT replies.
  entry.client.disconnect();
};
const sweepIdle = () => {
  const now = Date.now();
  for (const [id, entry] of tenantClients)
    if (!entry.pending && now - entry.lastUsed >= IDLE_CLIENT_MS) retireClient(id, entry);
  if (!tenantClients.size) {
    clearInterval(idleSweep);
    idleSweep = undefined;
  }
};
let redisEnabled: boolean | undefined;

const tenantClient = (tenantId: string): TenantRedisClient | null => {
  const existing = tenantClients.get(tenantId);
  if (existing) {
    existing.lastUsed = Date.now();
    tenantClients.delete(tenantId);
    tenantClients.set(tenantId, existing);
    return existing;
  }
  if (tenantClients.size >= MAX_TENANT_CLIENTS) {
    const idle = [...tenantClients].find(([, entry]) => !entry.pending);
    if (!idle) throw new Error('TENANT_REDIS_CAPACITY');
    retireClient(...idle);
  }

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

  const entry = { client, lastUsed: Date.now(), pending: 0 };
  tenantClients.set(tenantId, entry);
  if (!idleSweep) {
    idleSweep = setInterval(sweepIdle, IDLE_CLIENT_MS);
    idleSweep.unref();
  }
  return entry;
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
      const entry = tenantClient(requireTenantScope().tenantId);
      if (!entry) return undefined;
      const { client } = entry;
      const value = Reflect.get(client, prop, client);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        entry.pending += 1;
        const release = () => {
          entry.pending -= 1;
          entry.lastUsed = Date.now();
        };
        try {
          const result = value.apply(client, args);
          if (prop === 'pipeline' || prop === 'multi') {
            // An unexecuted transaction retains its socket until exec.
            let released = false;
            const finish = () => {
              if (!released) {
                released = true;
                release();
              }
            };
            for (const method of ['exec']) {
              const invoke = result[method];
              if (typeof invoke !== 'function') continue;
              result[method] = (...input: unknown[]) => {
                try {
                  return Promise.resolve(invoke.apply(result, input)).finally(finish);
                } catch (error) {
                  finish();
                  throw error;
                }
              };
            }
            return result;
          }
          if (result && typeof result.then === 'function') return result.finally(release);
          release();
          return result;
        } catch (error) {
          release();
          throw error;
        }
      };
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
  clearInterval(idleSweep);
  idleSweep = undefined;
  await Promise.all(clients.map(({ client }) => client.quit()));
}

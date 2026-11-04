import type Redis from 'ioredis';

import { getAgentRuntimeRedisClient } from '@/server/modules/AgentRuntime/redis';
import { isHatchetDeliveryEnabled } from '@/server/modules/Hatchet/config';

import type { WorkflowRunStatus } from './types';

/** How long a run's steps and status are kept after its last write. */
export const RUN_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * Durable state of workflow runs: step results (so a redelivery replays rather
 * than repeats them), terminal status, the lock that keeps one delivery of a
 * run executing at a time, the index of active runs, and flow-control slots.
 */
export interface WorkflowStore {
  acquireLock: (runId: string, token: string, ttlMs: number) => Promise<boolean>;
  /** Takes a slot of `key` unless `parallelism` are held; expired leases do not count. */
  acquireSlot: (
    key: string,
    token: string,
    parallelism: number,
    leaseMs: number,
  ) => Promise<boolean>;
  /** Runs registered as active whose URL starts with `prefix`. */
  activeRunsWithPrefix: (prefix: string) => Promise<string[]>;
  getStatus: (runId: string) => Promise<WorkflowRunStatus | undefined>;
  getStep: (runId: string, key: string) => Promise<string | undefined>;
  loadSteps: (runId: string) => Promise<Map<string, string>>;
  registerActive: (runId: string, url: string) => Promise<void>;
  releaseLock: (runId: string, token: string) => Promise<void>;
  releaseSlot: (key: string, token: string) => Promise<void>;
  renewLock: (runId: string, token: string, ttlMs: number) => Promise<void>;
  renewSlot: (key: string, token: string, leaseMs: number) => Promise<void>;
  saveStep: (runId: string, key: string, value: string) => Promise<void>;
  /** Terminal: also drops the run from the active index. */
  setStatus: (runId: string, status: WorkflowRunStatus) => Promise<void>;
  /** Counts one start in the current `periodMs` window; ms to wait when `limit` is reached, else 0. */
  takeRate: (key: string, limit: number, periodMs: number) => Promise<number>;
}

const runKey = (runId: string, part: string) => `workflow:run:${runId}:${part}`;
const ACTIVE_KEY = 'workflow:active';
const slotKey = (key: string) => `workflow:flow:${key}:slots`;
const rateKey = (key: string, window: number) => `workflow:flow:${key}:rate:${window}`;

const RELEASE_IF_OWNER = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`;
const RENEW_IF_OWNER = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) end return 0`;
const ACQUIRE_SLOT = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
if redis.call('ZSCORE', KEYS[1], ARGV[2]) then
  redis.call('ZADD', KEYS[1], ARGV[3], ARGV[2])
  return 1
end
if redis.call('ZCARD', KEYS[1]) < tonumber(ARGV[4]) then
  redis.call('ZADD', KEYS[1], ARGV[3], ARGV[2])
  redis.call('PEXPIRE', KEYS[1], ARGV[5])
  return 1
end
return 0`;

export class RedisWorkflowStore implements WorkflowStore {
  constructor(private readonly redis: Redis) {}

  async acquireLock(runId: string, token: string, ttlMs: number) {
    return (await this.redis.set(runKey(runId, 'lock'), token, 'PX', ttlMs, 'NX')) === 'OK';
  }

  async acquireSlot(key: string, token: string, parallelism: number, leaseMs: number) {
    const now = Date.now();
    const acquired = await this.redis.eval(
      ACQUIRE_SLOT,
      1,
      slotKey(key),
      String(now),
      token,
      String(now + leaseMs),
      String(parallelism),
      String(leaseMs * 4),
    );
    return acquired === 1;
  }

  async activeRunsWithPrefix(prefix: string) {
    const entries = await this.redis.hgetall(ACTIVE_KEY);
    return Object.entries(entries)
      .filter(([, url]) => url.startsWith(prefix))
      .map(([runId]) => runId);
  }

  async getStatus(runId: string) {
    return ((await this.redis.get(runKey(runId, 'status'))) ?? undefined) as
      WorkflowRunStatus | undefined;
  }

  async getStep(runId: string, key: string) {
    return (await this.redis.hget(runKey(runId, 'steps'), key)) ?? undefined;
  }

  async loadSteps(runId: string) {
    return new Map(Object.entries(await this.redis.hgetall(runKey(runId, 'steps'))));
  }

  async registerActive(runId: string, url: string) {
    await this.redis.hset(ACTIVE_KEY, runId, url);
  }

  async releaseLock(runId: string, token: string) {
    await this.redis.eval(RELEASE_IF_OWNER, 1, runKey(runId, 'lock'), token);
  }

  async releaseSlot(key: string, token: string) {
    await this.redis.zrem(slotKey(key), token);
  }

  async renewLock(runId: string, token: string, ttlMs: number) {
    await this.redis.eval(RENEW_IF_OWNER, 1, runKey(runId, 'lock'), token, String(ttlMs));
  }

  async renewSlot(key: string, token: string, leaseMs: number) {
    await this.redis.zadd(slotKey(key), 'XX', Date.now() + leaseMs, token);
  }

  async saveStep(runId: string, key: string, value: string) {
    const steps = runKey(runId, 'steps');
    await this.redis.multi().hset(steps, key, value).expire(steps, RUN_TTL_SECONDS).exec();
  }

  async setStatus(runId: string, status: WorkflowRunStatus) {
    await this.redis
      .multi()
      .set(runKey(runId, 'status'), status, 'EX', RUN_TTL_SECONDS)
      .hdel(ACTIVE_KEY, runId)
      .exec();
  }

  async takeRate(key: string, limit: number, periodMs: number) {
    const now = Date.now();
    const window = Math.floor(now / periodMs);
    const counter = rateKey(key, window);
    const [[, count]] = (await this.redis
      .multi()
      .incr(counter)
      .pexpire(counter, periodMs * 2)
      .exec()) as [[unknown, number], unknown];
    return count <= limit ? 0 : (window + 1) * periodMs - now;
  }
}

/** One process's state, for local mode where deliveries never leave this process. */
export class MemoryWorkflowStore implements WorkflowStore {
  private readonly active = new Map<string, string>();
  private readonly locks = new Map<string, { expiresAt: number; token: string }>();
  private readonly rates = new Map<string, number>();
  private readonly slots = new Map<string, Map<string, number>>();
  private readonly status = new Map<string, WorkflowRunStatus>();
  private readonly steps = new Map<string, Map<string, string>>();

  async acquireLock(runId: string, token: string, ttlMs: number) {
    const held = this.locks.get(runId);
    if (held && held.expiresAt > Date.now()) return false;
    this.locks.set(runId, { expiresAt: Date.now() + ttlMs, token });
    return true;
  }

  async acquireSlot(key: string, token: string, parallelism: number, leaseMs: number) {
    const now = Date.now();
    const holders = this.slots.get(key) ?? new Map<string, number>();
    for (const [holder, expiresAt] of holders) if (expiresAt <= now) holders.delete(holder);
    this.slots.set(key, holders);
    if (!holders.has(token) && holders.size >= parallelism) return false;
    holders.set(token, now + leaseMs);
    return true;
  }

  async activeRunsWithPrefix(prefix: string) {
    return [...this.active].filter(([, url]) => url.startsWith(prefix)).map(([runId]) => runId);
  }

  async getStatus(runId: string) {
    return this.status.get(runId);
  }

  async getStep(runId: string, key: string) {
    return this.steps.get(runId)?.get(key);
  }

  async loadSteps(runId: string) {
    return new Map(this.steps.get(runId));
  }

  async registerActive(runId: string, url: string) {
    this.active.set(runId, url);
  }

  async releaseLock(runId: string, token: string) {
    if (this.locks.get(runId)?.token === token) this.locks.delete(runId);
  }

  async releaseSlot(key: string, token: string) {
    this.slots.get(key)?.delete(token);
  }

  async renewLock(runId: string, token: string, ttlMs: number) {
    const held = this.locks.get(runId);
    if (held?.token === token) held.expiresAt = Date.now() + ttlMs;
  }

  async renewSlot(key: string, token: string, leaseMs: number) {
    const holders = this.slots.get(key);
    if (holders?.has(token)) holders.set(token, Date.now() + leaseMs);
  }

  async saveStep(runId: string, key: string, value: string) {
    const steps = this.steps.get(runId) ?? new Map<string, string>();
    steps.set(key, value);
    this.steps.set(runId, steps);
  }

  async setStatus(runId: string, status: WorkflowRunStatus) {
    this.status.set(runId, status);
    this.active.delete(runId);
  }

  async takeRate(key: string, limit: number, periodMs: number) {
    const now = Date.now();
    const window = Math.floor(now / periodMs);
    const counter = `${key}:${window}`;
    const count = (this.rates.get(counter) ?? 0) + 1;
    this.rates.set(counter, count);
    for (const name of this.rates.keys())
      if (!name.endsWith(`:${window}`) && name.startsWith(`${key}:`)) this.rates.delete(name);
    return count <= limit ? 0 : (window + 1) * periodMs - now;
  }
}

let memoryStore: MemoryWorkflowStore | undefined;

/**
 * Queue mode keeps run state in the (tenant-scoped) agent runtime Redis, which
 * every replica shares; local mode keeps it in this process, where its
 * deliveries run too.
 */
export const getWorkflowStore = (): WorkflowStore => {
  if (isHatchetDeliveryEnabled()) {
    const redis = getAgentRuntimeRedisClient();
    if (!redis) throw new Error('Workflows in queue mode need the agent runtime Redis');
    return new RedisWorkflowStore(redis);
  }
  return (memoryStore ??= new MemoryWorkflowStore());
};

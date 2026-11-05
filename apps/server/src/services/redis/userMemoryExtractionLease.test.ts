import { beforeEach, describe, expect, it, vi } from 'vitest';

import { userMemoryExtractionLease } from './userMemoryExtractionLease';

const store = new Map<string, string>();
const redis = vi.hoisted(() => ({ client: null as any }));
vi.mock('./client', () => ({ getRedisServiceClient: async () => redis.client }));

const memoryClient = {
  eval: vi.fn(async (_script: string, _keys: number, key: string, owner: string) => {
    if (store.get(key) !== owner) return 0;
    store.delete(key);
    return 1;
  }),
  get: vi.fn(async (key: string) => store.get(key) ?? null),
  set: vi.fn(async (key: string, value: string, options: { nx?: boolean }) => {
    if (options.nx && store.has(key)) return null;
    store.set(key, value);
    return 'OK';
  }),
};

beforeEach(() => {
  store.clear();
  vi.clearAllMocks();
  redis.client = memoryClient;
});

describe('redisService.userMemoryExtractionLease', () => {
  it('lets one run at a time work on a user, and the holder take it again', async () => {
    expect(await userMemoryExtractionLease.acquire('u1', 'run-a')).toBe(true);
    expect(memoryClient.set).toHaveBeenCalledWith('extraction_run_lease:v1:u1', 'run-a', {
      ex: 3 * 60 * 60,
      nx: true,
    });

    expect(await userMemoryExtractionLease.acquire('u1', 'run-b')).toBe(false);
    // A replayed step of the holder.
    expect(await userMemoryExtractionLease.acquire('u1', 'run-a')).toBe(true);
    expect(await userMemoryExtractionLease.acquire('u2', 'run-b')).toBe(true);
  });

  it('is given back only by its holder', async () => {
    await userMemoryExtractionLease.acquire('u1', 'run-a');

    await userMemoryExtractionLease.release('u1', 'run-b');
    expect(await userMemoryExtractionLease.acquire('u1', 'run-b')).toBe(false);

    await userMemoryExtractionLease.release('u1', 'run-a');
    expect(await userMemoryExtractionLease.acquire('u1', 'run-b')).toBe(true);
  });

  it('lets every run go ahead without Redis', async () => {
    redis.client = null;

    expect(await userMemoryExtractionLease.acquire('u1', 'run-a')).toBe(true);
    expect(await userMemoryExtractionLease.acquire('u1', 'run-b')).toBe(true);
    await expect(userMemoryExtractionLease.release('u1', 'run-a')).resolves.toBeUndefined();
  });
});

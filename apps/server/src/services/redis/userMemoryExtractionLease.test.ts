import { beforeEach, describe, expect, it, vi } from 'vitest';

import { userMemoryExtractionLease } from './userMemoryExtractionLease';

const store = new Map<string, string>();
const redis = vi.hoisted(() => ({ client: null as any }));
vi.mock('./client', () => ({ getRedisServiceClient: async () => redis.client }));

const memoryClient = {
  // Stands in for the two scripts: hold (extend or retake) and release (delete if owner).
  eval: vi.fn(async (script: string, _keys: number, key: string, owner: string) => {
    if (script.includes('EXPIRE')) {
      const holder = store.get(key);
      if (holder !== undefined && holder !== owner) return 0;
      store.set(key, owner);
      return 1;
    }
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

  it('keeps a working run holding the user, even past a lapse, until another run takes it', async () => {
    await userMemoryExtractionLease.acquire('u1', 'run-a');
    expect(await userMemoryExtractionLease.hold('u1', 'run-a')).toBe(true);
    expect(memoryClient.eval).toHaveBeenLastCalledWith(
      expect.stringContaining('EXPIRE'),
      1,
      'extraction_run_lease:v1:u1',
      'run-a',
      String(3 * 60 * 60),
    );

    // Lapsed: the run still working takes it again.
    store.clear();
    expect(await userMemoryExtractionLease.hold('u1', 'run-a')).toBe(true);
    expect(await userMemoryExtractionLease.acquire('u1', 'run-b')).toBe(false);

    // Lapsed and taken by the next hourly run: the long run has to stop.
    store.set('extraction_run_lease:v1:u1', 'run-b');
    expect(await userMemoryExtractionLease.hold('u1', 'run-a')).toBe(false);
  });

  it('lets every run go ahead without Redis', async () => {
    redis.client = null;

    expect(await userMemoryExtractionLease.acquire('u1', 'run-a')).toBe(true);
    expect(await userMemoryExtractionLease.acquire('u1', 'run-b')).toBe(true);
    expect(await userMemoryExtractionLease.hold('u1', 'run-a')).toBe(true);
    await expect(userMemoryExtractionLease.release('u1', 'run-a')).resolves.toBeUndefined();
  });
});

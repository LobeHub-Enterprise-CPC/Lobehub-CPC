// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { SnapshotCache } from './snapshotCache';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
};

describe('SnapshotCache per-key invalidation', () => {
  it('drops only the invalidated key and keeps other tenants cached', async () => {
    const load = vi.fn(async (key: string) => ({ key }));
    const cache = new SnapshotCache(load, () => 1000);
    await cache.get('a');
    await cache.get('b');
    expect(load).toHaveBeenCalledTimes(2);
    cache.invalidateKey('a');
    await cache.get('b');
    expect(load).toHaveBeenCalledTimes(2);
    await cache.get('a');
    expect(load).toHaveBeenCalledTimes(3);
  });

  it('refuses a cached-path read that started before the key was invalidated, but not other keys', async () => {
    const pending: Record<string, ReturnType<typeof deferred<{ key: string }>>> = {
      a: deferred(),
      b: deferred(),
    };
    const cache = new SnapshotCache(
      (key) => pending[key].promise,
      () => 1000,
    );
    const readA = cache.get('a');
    const readB = cache.get('b');
    const refusalA = expect(readA).rejects.toMatchObject({ reason: 'ROUTING_GENERATION_CHANGED' });
    cache.invalidateKey('a');
    pending.a.resolve({ key: 'a' });
    pending.b.resolve({ key: 'b' });
    await refusalA;
    await expect(readB).resolves.toEqual({ key: 'b' });
  });

  it('does not let a strict read that started before invalidation answer or repopulate', async () => {
    const first = deferred<{ key: string }>();
    const load = vi
      .fn<(key: string) => Promise<{ key: string; version: number } | null>>()
      .mockImplementationOnce(async () => (await first.promise, { key: 'a', version: 1 }))
      .mockResolvedValue({ key: 'a', version: 2 });
    const cache = new SnapshotCache(load, () => 1000);
    const strict = cache.getStrict('a');
    const refusal = expect(strict).rejects.toMatchObject({ reason: 'ROUTING_GENERATION_CHANGED' });
    cache.invalidateKey('a');
    first.resolve({ key: 'a' });
    await refusal;
    await expect(cache.get('a')).resolves.toEqual({ key: 'a', version: 2 });
  });

  it('forgets invalidation markers once every older read has expired', async () => {
    let now = 1000;
    const load = vi.fn(async (key: string) => ({ key }));
    const cache = new SnapshotCache(load, () => now);
    cache.invalidateKey('a');
    now += 5001;
    cache.invalidateKey('b');
    await expect(cache.get('a')).resolves.toEqual({ key: 'a' });
    expect(cache.invalidationMarkers).toBe(1);
  });
});

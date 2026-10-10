import { describe, expect, it, vi } from 'vitest';

import { TenantClaims } from './claims';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe('durable tenant work claims', () => {
  it('records admission before work and retains the claim until every child ends', async () => {
    const admitted = deferred();
    const store = { acquire: vi.fn(() => admitted.promise), release: vi.fn(async () => {}) };
    const claims = new TenantClaims(store);
    let started = false;
    const entering = claims.enter('a').then((release) => {
      started = true;
      return release;
    });
    await Promise.resolve();
    expect(started).toBe(false);
    admitted.resolve();
    const release = await entering;
    const child = claims.bind('a');
    await release();
    expect(store.release).not.toHaveBeenCalled();
    await child();
    expect(store.release).toHaveBeenCalledTimes(1);
  });

  it('waits for a pending durable release before admitting replacement work', async () => {
    const deletion = deferred();
    const store = { acquire: vi.fn(async () => {}), release: vi.fn(() => deletion.promise) };
    const claims = new TenantClaims(store);
    const release = await claims.enter('a');
    const closing = release();
    let started = false;
    const entering = claims.enter('a').then((done) => {
      started = true;
      return done;
    });
    await Promise.resolve();
    expect(started).toBe(false);
    deletion.resolve();
    await closing;
    const done = await entering;
    expect(store.acquire).toHaveBeenCalledTimes(2);
    await done();
  });

  it('refuses detached children and retries failed acquisition without leaking pins', async () => {
    const store = {
      acquire: vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined),
      release: vi.fn(async () => {}),
    };
    const claims = new TenantClaims(store);
    expect(() => claims.bind('a')).toThrow();
    await expect(claims.enter('a')).rejects.toThrow('offline');
    const done = await claims.enter('a');
    await done();
    expect(store.release).toHaveBeenCalledTimes(1);
    expect(claims.isHeld('a')).toBe(false);
  });

  it('rechecks admission for a new request even while this process has existing work', async () => {
    const store = {
      acquire: vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('frozen')),
      release: vi.fn(async () => {}),
    };
    const claims = new TenantClaims(store);
    const first = await claims.enter('a');
    await expect(claims.enter('a')).rejects.toThrow('frozen');
    expect(store.release).not.toHaveBeenCalled();
    await first();
    expect(store.release).toHaveBeenCalledTimes(1);
  });

  it('pins an admission recheck so the last prior request cannot release under it', async () => {
    const pending = deferred();
    const store = {
      acquire: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockImplementationOnce(() => pending.promise),
      release: vi.fn(async () => {}),
    };
    const claims = new TenantClaims(store);
    const first = await claims.enter('a');
    const entering = claims.enter('a');
    await first();
    expect(store.release).not.toHaveBeenCalled();
    pending.resolve();
    const second = await entering;
    expect(store.release).not.toHaveBeenCalled();
    await second();
    expect(store.release).toHaveBeenCalledTimes(1);
  });

  it('keeps a failed release durable and never admits using its uncertain claim', async () => {
    const store = {
      acquire: vi.fn(async () => {}),
      release: vi.fn().mockRejectedValueOnce(new Error('partition')).mockResolvedValue(undefined),
    };
    const claims = new TenantClaims(store);
    const done = await claims.enter('a');
    await expect(done()).rejects.toThrow('partition');
    expect(claims.isHeld('a')).toBe(false);
    const next = await claims.enter('a');
    expect(store.release).toHaveBeenCalledTimes(2);
    expect(store.acquire).toHaveBeenCalledTimes(2);
    await next();
  });
});

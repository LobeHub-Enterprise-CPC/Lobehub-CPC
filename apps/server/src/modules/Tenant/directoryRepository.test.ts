import type { PlatformDatabase } from '@lobechat/database/platform';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TenantDirectoryRepository } from './directoryRepository';

const active = { directory: { tenantId: 'tenant-acme' }, lifecycle: { desiredState: 'active' } };
const frozen = { ...active, lifecycle: { desiredState: 'frozen' } };

const setup = () => {
  const read = vi.fn(async () => [active]);
  const query = { limit: read };
  const platform = {
    select: () => ({ from: () => ({ leftJoin: () => ({ where: () => query }) }) }),
  } as unknown as PlatformDatabase;
  return { read, repository: new TenantDirectoryRepository(() => platform) };
};

afterEach(() => vi.restoreAllMocks());

describe('tenant directory snapshots', () => {
  it('shares concurrent lookups while keeping different tenant slugs separate', async () => {
    const { read, repository } = setup();
    const other = {
      directory: { tenantId: 'tenant-other' },
      lifecycle: { desiredState: 'active' },
    };
    read.mockResolvedValueOnce([active]).mockResolvedValueOnce([other]);

    const [first, second, third] = await Promise.all([
      repository.findBySlug('acme'),
      repository.findBySlug('acme'),
      repository.findBySlug('other'),
    ]);
    expect(first?.directory.tenantId).toBe('tenant-acme');
    expect(second?.directory.tenantId).toBe('tenant-acme');
    expect(third?.directory.tenantId).toBe('tenant-other');
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('refreshes persisted lifecycle state after the five-second cache window', async () => {
    let now = performance.now();
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const { read, repository } = setup();
    await repository.findBySlug('acme');
    read.mockResolvedValue([frozen]);
    now += 4999;
    expect((await repository.findBySlug('acme'))?.lifecycle?.desiredState).toBe('active');
    now += 2;
    expect((await repository.findBySlug('acme'))?.lifecycle?.desiredState).toBe('frozen');
  });

  it('does not let an in-flight lookup restore a snapshot invalidated by a lifecycle write', async () => {
    const { read, repository } = setup();
    const pending = Promise.withResolvers<(typeof active)[]>();
    read.mockReturnValueOnce(pending.promise);
    const beforeWrite = repository.findBySlug('acme');
    const rejected = expect(beforeWrite).rejects.toMatchObject({ code: 'TENANT_UNAVAILABLE' });

    repository.invalidate();
    await rejected;
    read.mockResolvedValue([frozen]);
    expect((await repository.findBySlug('acme'))?.lifecycle?.desiredState).toBe('frozen');

    pending.resolve([active]);
    await pending.promise;
    expect((await repository.findBySlug('acme'))?.lifecycle?.desiredState).toBe('frozen');
  });

  it('fails closed on database errors and retries after recovery', async () => {
    const { read, repository } = setup();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    read.mockRejectedValueOnce(new Error('database unavailable'));

    await expect(repository.findBySlug('acme')).rejects.toMatchObject({
      code: 'TENANT_UNAVAILABLE',
    });
    expect((await repository.findBySlug('acme'))?.directory.tenantId).toBe('tenant-acme');
  });
});

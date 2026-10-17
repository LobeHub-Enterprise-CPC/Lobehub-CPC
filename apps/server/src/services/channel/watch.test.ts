// @vitest-environment node
import { runWithTenantScope, type TenantScope } from '@lobechat/database/tenant';
import { describe, expect, it, vi } from 'vitest';

import type { ChannelModel } from '@/database/models/channel';

import { watchChannel } from './watch';

type Revision = Awaited<ReturnType<ChannelModel['revision']>>;
describe('Channel shared snapshots', () => {
  it('shares concurrent sampling for one owner and evicts on last disconnect', async () => {
    const load = vi
      .fn()
      .mockResolvedValue({ revision: 'one', navigationRevision: 'nav' } satisfies Revision);
    const first = watchChannel('owner:channel', load);
    const second = watchChannel('owner:channel', load);
    await Promise.all([first.next(), second.next()]);
    expect(load).toHaveBeenCalledTimes(1);
    await first.return();
    await second.return();
    const next = watchChannel('owner:channel', load);
    await next.next();
    expect(load).toHaveBeenCalledTimes(2);
    await next.return();
  });
  it('does not reuse snapshots across owners, and drops rejected loads', async () => {
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error('Temporary database failure'))
      .mockResolvedValue({ revision: 'one', navigationRevision: 'nav' } satisfies Revision);
    const failed = watchChannel('owner:failed', load);
    await expect(failed.next()).rejects.toThrow('Temporary');
    const first = watchChannel('owner:failed', load);
    const second = watchChannel('other:failed', load);
    await first.next();
    await second.next();
    expect(load).toHaveBeenCalledTimes(3);
    await first.return();
    await second.return();
  });
  it('does not reuse snapshots across tenants for the same owner and channel', async () => {
    const inTenant = <T>(tenantId: string, fn: () => T) =>
      runWithTenantScope({ session: {}, slug: tenantId, tenantId } as unknown as TenantScope, fn);
    const loadOf = (revision: string) =>
      vi.fn().mockResolvedValue({ revision, navigationRevision: 'nav' } satisfies Revision);
    const loadA = loadOf('tenant-a-data');
    const loadB = loadOf('tenant-b-data');

    const a = inTenant('tenant-a', () => watchChannel('owner:channel', loadA));
    const b = inTenant('tenant-b', () => watchChannel('owner:channel', loadB));
    const [first, second] = await Promise.all([
      inTenant('tenant-a', () => a.next()),
      inTenant('tenant-b', () => b.next()),
    ]);

    expect(first.value).toMatchObject({ revision: 'tenant-a-data' });
    expect(second.value).toMatchObject({ revision: 'tenant-b-data' });
    expect(loadB).toHaveBeenCalledTimes(1);
    await a.return();
    await b.return();
  });
});

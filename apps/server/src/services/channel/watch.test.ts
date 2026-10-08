// @vitest-environment node
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
});

import { setRemoteTenantId } from '@lobechat/business-tenant/client';
import { afterEach, describe, expect, it } from 'vitest';

import { getPinnedPages, savePinnedPages } from './storage';

const scope = { type: 'personal' } as const;

afterEach(() => {
  setRemoteTenantId(undefined);
  window.localStorage.clear();
});

describe('pinned pages storage', () => {
  it('keeps each organization of the desktop renderer in its own bucket', () => {
    setRemoteTenantId('tenant-a');
    savePinnedPages(scope, [{ id: 'a', lastVisited: 1, url: '/agent/a1' }]);

    setRemoteTenantId('tenant-b');
    expect(getPinnedPages(scope)).toEqual([]);

    setRemoteTenantId('tenant-a');
    expect(getPinnedPages(scope)).toEqual([{ id: 'a', lastVisited: 1, url: '/agent/a1' }]);
  });
});

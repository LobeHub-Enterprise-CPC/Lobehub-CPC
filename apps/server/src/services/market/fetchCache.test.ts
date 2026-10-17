import { runWithTenantScope, type TenantScope } from '@lobechat/database/tenant';
import { describe, expect, it } from 'vitest';

import { marketFetchCache } from './fetchCache';

const next = { revalidate: 3600, tags: ['discover'] };

describe('marketFetchCache', () => {
  // A tenant's answer contains its own internal content; the shared fetch cache
  // must never be asked to hold or serve it.
  it('skips the data cache inside a tenant', () => {
    const options = runWithTenantScope(
      { session: {}, slug: 'acme', tenantId: 'tenant-a' } as unknown as TenantScope,
      () => marketFetchCache(next),
    );

    expect(options).toEqual({ cache: 'no-store' });
  });

  it('keeps revalidation for a deployment without tenants', () => {
    expect(marketFetchCache(next)).toEqual({ next });
  });
});

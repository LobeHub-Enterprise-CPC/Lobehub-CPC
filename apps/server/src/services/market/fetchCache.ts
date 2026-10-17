import { currentTenantScope } from '@lobechat/database/tenant';

type NextFetchOptions = NonNullable<RequestInit['next']>;

/**
 * Request options for a Market read that used to be served from Next's data
 * cache.
 *
 * Inside a tenant scope the answer depends on who asks: a tenant sees its own
 * internal content next to the public catalogue. The fetch cache is keyed on
 * the URL and headers, which is not an isolation boundary anyone designed, so
 * tenant requests skip it altogether. Outside a scope (a deployment without
 * tenants) the catalogue is the same for everyone and the cache stays.
 */
export const marketFetchCache = (next: NextFetchOptions): RequestInit =>
  currentTenantScope() ? { cache: 'no-store' } : { next };

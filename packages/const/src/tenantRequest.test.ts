import { describe, expect, it } from 'vitest';

import { resolveRequestTenant } from './tenantRequest';

describe('resolveRequestTenant', () => {
  it('reads the tenant from the path', () => {
    expect(resolveRequestTenant({ pathname: '/t/acme/trpc/lambda/agent' })).toEqual({
      ok: true,
      tenantSlug: 'acme',
    });
  });

  it('returns no tenant for an unscoped path', () => {
    expect(resolveRequestTenant({ pathname: '/trpc/lambda/agent' })).toEqual({
      ok: true,
      tenantSlug: null,
    });
  });

  it('accepts a matching token claim', () => {
    expect(resolveRequestTenant({ pathname: '/t/acme/api/x', tokenTenantSlug: 'acme' })).toEqual({
      ok: true,
      tenantSlug: 'acme',
    });
  });

  it('lets a token scope a request that has no path prefix', () => {
    // How a CLI or API-key client addresses a tenant without a URL prefix.
    expect(resolveRequestTenant({ pathname: '/webapi/chat', tokenTenantSlug: 'acme' })).toEqual({
      ok: true,
      tenantSlug: 'acme',
    });
  });

  it('REFUSES a token/path disagreement rather than picking one', () => {
    // Preferring the token ignores what the user asked for; preferring the path
    // lets a token minted for `other` act on `acme`. Both complete successfully
    // and read as an ordinary authorized request in the logs.
    expect(resolveRequestTenant({ pathname: '/t/acme/trpc/x', tokenTenantSlug: 'other' })).toEqual({
      ok: false,
      reason: 'conflict',
    });
  });

  it('refuses a malformed tenant segment instead of downgrading to unscoped', () => {
    // Silently reading `/t/UPPER/...` as "no tenant" turns a scoped request into
    // an unscoped one, which is the failure this check exists to prevent.
    expect(resolveRequestTenant({ pathname: '/t/UPPER/trpc/x' })).toEqual({
      ok: false,
      reason: 'malformed',
    });
    expect(resolveRequestTenant({ pathname: '/t/' })).toEqual({ ok: false, reason: 'malformed' });
    expect(resolveRequestTenant({ pathname: '/t' })).toEqual({ ok: false, reason: 'malformed' });
  });

  it('does not mistake a path merely starting with "t" for a tenant path', () => {
    expect(resolveRequestTenant({ pathname: '/tasks/123' })).toEqual({
      ok: true,
      tenantSlug: null,
    });
    expect(resolveRequestTenant({ pathname: '/trpc/x' })).toEqual({ ok: true, tenantSlug: null });
  });

  it('takes no header input at all', () => {
    // Guards the design, not an implementation detail: a header-supplied tenant
    // would be attacker-controlled input silently overriding the visited path.
    // If someone adds a header parameter, this assertion is where they must
    // justify it.
    expect(resolveRequestTenant.length).toBe(1);
    const arg = { pathname: '/t/acme/api/x' };
    expect(resolveRequestTenant({ ...arg, ...({ headerTenantSlug: 'evil' } as object) })).toEqual({
      ok: true,
      tenantSlug: 'acme',
    });
  });
});

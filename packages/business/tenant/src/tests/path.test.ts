import { describe, expect, it } from 'vitest';

import { parseTenantPath, stripTenantPath, withTenantPath } from '../path';

describe('parseTenantPath', () => {
  it('splits a tenant-prefixed path', () => {
    expect(parseTenantPath('/t/acme/agent/123')).toEqual({
      rest: '/agent/123',
      tenantSlug: 'acme',
    });
  });

  it('returns "/" for the tenant root', () => {
    expect(parseTenantPath('/t/acme')).toEqual({ rest: '/', tenantSlug: 'acme' });
  });

  it('keeps query and hash on the rest', () => {
    expect(parseTenantPath('/t/acme/agent?tab=1#x')).toEqual({
      rest: '/agent?tab=1#x',
      tenantSlug: 'acme',
    });
    expect(parseTenantPath('/t/acme?tab=1')).toEqual({ rest: '?tab=1', tenantSlug: 'acme' });
  });

  it('leaves an unprefixed path alone', () => {
    expect(parseTenantPath('/agent/123')).toEqual({ rest: '/agent/123', tenantSlug: null });
  });

  it('does not treat a bare /t as a tenant path', () => {
    expect(parseTenantPath('/t')).toEqual({ rest: '/t', tenantSlug: null });
  });

  it('falls through on a malformed slug rather than inventing a tenant', () => {
    // A url that 404s visibly beats one that resolves to "tenant not found" —
    // the latter reads as a permissions problem to whoever reports it.
    for (const bad of [
      '/t/UPPER/agent',
      '/t/-lead/agent',
      '/t/trail-/agent',
      '/t//agent',
      // Console never registers these, so they must not parse as tenants.
      '/t/9lives/agent',
      '/t/a/agent',
      '/t/double--dash/agent',
      `/t/${'a'.repeat(64)}/agent`,
    ]) {
      expect(parseTenantPath(bad).tenantSlug).toBeNull();
    }
  });

  it('accepts every shape Console can register', () => {
    for (const ok of ['ab', 'acme', 'acme-corp', 'a1-b2-c3', `a${'b'.repeat(62)}`]) {
      expect(parseTenantPath(`/t/${ok}/agent`).tenantSlug).toBe(ok);
    }
  });

  it('accepts a slug that is only reserved at the root', () => {
    // `/t/agent` is unambiguous BECAUSE the prefix is explicit. Registration is
    // what must reject `agent`, not parsing.
    expect(parseTenantPath('/t/agent/settings')).toEqual({
      rest: '/settings',
      tenantSlug: 'agent',
    });
  });
});

describe('withTenantPath', () => {
  it('prefixes an absolute path', () => {
    expect(withTenantPath('/agent/1', 'acme')).toBe('/t/acme/agent/1');
  });

  it('maps root to the tenant root without a trailing slash', () => {
    expect(withTenantPath('/', 'acme')).toBe('/t/acme');
  });

  it('is idempotent', () => {
    expect(withTenantPath(withTenantPath('/agent', 'acme'), 'acme')).toBe('/t/acme/agent');
  });

  it('re-points a path already prefixed with a different tenant', () => {
    expect(withTenantPath('/t/other/agent', 'acme')).toBe('/t/acme/t/other/agent');
  });

  it('leaves relative paths and empty tenants alone', () => {
    expect(withTenantPath('agent', 'acme')).toBe('agent');
    expect(withTenantPath('/agent', null)).toBe('/agent');
  });

  it('round-trips with stripTenantPath', () => {
    expect(stripTenantPath(withTenantPath('/agent/1', 'acme'))).toBe('/agent/1');
  });
});

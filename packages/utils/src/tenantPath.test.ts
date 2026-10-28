import { describe, expect, it } from 'vitest';

import {
  belowTenantPrefix,
  hasTenantPrefix,
  isLegacyTenantPath,
  mapTenantAppPath,
  parseTenantPath,
  stripTenantPath,
  withTenantPath,
} from './tenantPath';

describe('parseTenantPath', () => {
  it('splits a tenant-prefixed path', () => {
    expect(parseTenantPath('/orgs/acme/agent/123')).toEqual({
      rest: '/agent/123',
      tenantSlug: 'acme',
    });
  });

  it('returns "/" for the tenant root', () => {
    expect(parseTenantPath('/orgs/acme')).toEqual({ rest: '/', tenantSlug: 'acme' });
  });

  it('keeps query and hash on the rest', () => {
    expect(parseTenantPath('/orgs/acme/agent?tab=1#x')).toEqual({
      rest: '/agent?tab=1#x',
      tenantSlug: 'acme',
    });
    expect(parseTenantPath('/orgs/acme?tab=1')).toEqual({ rest: '?tab=1', tenantSlug: 'acme' });
  });

  it('leaves an unprefixed path alone', () => {
    expect(parseTenantPath('/agent/123')).toEqual({ rest: '/agent/123', tenantSlug: null });
  });

  it('does not treat a bare prefix as a tenant path', () => {
    expect(parseTenantPath('/orgs')).toEqual({ rest: '/orgs', tenantSlug: null });
    expect(parseTenantPath('/t')).toEqual({ rest: '/t', tenantSlug: null });
  });

  it('still reads the legacy /t prefix', () => {
    expect(parseTenantPath('/t/acme/agent?tab=1')).toEqual({
      rest: '/agent?tab=1',
      tenantSlug: 'acme',
    });
    expect(parseTenantPath('/t/acme')).toEqual({ rest: '/', tenantSlug: 'acme' });
  });

  it('only takes whole prefix segments', () => {
    expect(parseTenantPath('/org/acme/agent').tenantSlug).toBeNull();
    expect(parseTenantPath('/orgsx/acme/agent').tenantSlug).toBeNull();
    expect(parseTenantPath('/tx/acme/agent').tenantSlug).toBeNull();
  });

  it('falls through on a malformed slug rather than inventing a tenant', () => {
    // A url that 404s visibly beats one that resolves to "tenant not found" —
    // the latter reads as a permissions problem to whoever reports it.
    for (const bad of [
      '/orgs/UPPER/agent',
      '/orgs/-lead/agent',
      '/orgs/trail-/agent',
      '/orgs//agent',
      // Console never registers these, so they must not parse as tenants.
      '/orgs/9lives/agent',
      '/orgs/a/agent',
      '/orgs/double--dash/agent',
      `/orgs/${'a'.repeat(64)}/agent`,
    ]) {
      expect(parseTenantPath(bad).tenantSlug).toBeNull();
    }
  });

  it('accepts every shape Console can register', () => {
    for (const ok of ['ab', 'acme', 'acme-corp', 'a1-b2-c3', `a${'b'.repeat(62)}`]) {
      expect(parseTenantPath(`/orgs/${ok}/agent`).tenantSlug).toBe(ok);
    }
  });

  it('accepts a slug that is only reserved at the root', () => {
    // `/orgs/agent` is unambiguous BECAUSE the prefix is explicit. Registration is
    // what must reject `agent`, not parsing.
    expect(parseTenantPath('/orgs/agent/settings')).toEqual({
      rest: '/settings',
      tenantSlug: 'agent',
    });
  });
});

describe('withTenantPath', () => {
  it('prefixes an absolute path', () => {
    expect(withTenantPath('/agent/1', 'acme')).toBe('/orgs/acme/agent/1');
  });

  it('maps root to the tenant root without a trailing slash', () => {
    expect(withTenantPath('/', 'acme')).toBe('/orgs/acme');
  });

  it('is idempotent', () => {
    expect(withTenantPath(withTenantPath('/agent', 'acme'), 'acme')).toBe('/orgs/acme/agent');
  });

  it('re-points a path already prefixed with a different tenant', () => {
    expect(withTenantPath('/orgs/other/agent', 'acme')).toBe('/orgs/acme/orgs/other/agent');
  });

  it('moves a legacy prefix of the same tenant to the current one', () => {
    expect(withTenantPath('/t/acme/agent?tab=1', 'acme')).toBe('/orgs/acme/agent?tab=1');
    expect(withTenantPath('/t/acme', 'acme')).toBe('/orgs/acme');
  });

  it('leaves relative paths and empty tenants alone', () => {
    expect(withTenantPath('agent', 'acme')).toBe('agent');
    expect(withTenantPath('/agent', null)).toBe('/agent');
  });

  it('round-trips with stripTenantPath', () => {
    expect(stripTenantPath(withTenantPath('/agent/1', 'acme'))).toBe('/agent/1');
  });
});

describe('mapTenantAppPath', () => {
  it('rewrites the app path and keeps the tenant prefix', () => {
    expect(mapTenantAppPath('/orgs/acme/agent', (p) => `/ws${p}`)).toBe('/orgs/acme/ws/agent');
    expect(mapTenantAppPath('/t/acme/agent', (p) => `/ws${p}`)).toBe('/orgs/acme/ws/agent');
    expect(mapTenantAppPath('/agent', (p) => `/ws${p}`)).toBe('/ws/agent');
  });
});

describe('hasTenantPrefix', () => {
  it('matches both prefixes as whole segments, whatever follows', () => {
    for (const path of ['/orgs', '/orgs/', '/orgs/acme', '/orgs/BAD/x', '/t', '/t/acme/x'])
      expect(hasTenantPrefix(path)).toBe(true);
    for (const path of ['/', '/org/acme', '/orgsx', '/tasks', '/agent'])
      expect(hasTenantPrefix(path)).toBe(false);
  });
});

describe('isLegacyTenantPath', () => {
  it('is true only for a well-formed tenant under the legacy prefix', () => {
    expect(isLegacyTenantPath('/t/acme')).toBe(true);
    expect(isLegacyTenantPath('/t/acme/agent?x=1')).toBe(true);
    expect(isLegacyTenantPath('/orgs/acme/agent')).toBe(false);
    expect(isLegacyTenantPath('/t/BAD/agent')).toBe(false);
    expect(isLegacyTenantPath('/tasks')).toBe(false);
  });
});

describe('belowTenantPrefix', () => {
  it('drops the prefix and the segment after it, well-formed or not', () => {
    expect(belowTenantPrefix('/orgs/acme/api/x')).toBe('/api/x');
    expect(belowTenantPrefix('/t/BAD/api/x')).toBe('/api/x');
    expect(belowTenantPrefix('/orgs//api')).toBe('/api');
    expect(belowTenantPrefix('/orgs')).toBe('/');
    expect(belowTenantPrefix('/orgs/acme')).toBe('/');
    expect(belowTenantPrefix('/agent')).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';

import { isRegistrableSlug, isReservedSlug, RESERVED_SLUGS } from '../reservedSlugs';
import { buildTenantPath, parseTenantPath, stripTenantPath } from '../tenantPath';

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
    for (const bad of ['/t/UPPER/agent', '/t/-lead/agent', '/t/trail-/agent', '/t//agent']) {
      expect(parseTenantPath(bad).tenantSlug).toBeNull();
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

describe('buildTenantPath', () => {
  it('prefixes an absolute path', () => {
    expect(buildTenantPath('/agent/1', 'acme')).toBe('/t/acme/agent/1');
  });

  it('maps root to the tenant root without a trailing slash', () => {
    expect(buildTenantPath('/', 'acme')).toBe('/t/acme');
  });

  it('is idempotent', () => {
    expect(buildTenantPath(buildTenantPath('/agent', 'acme'), 'acme')).toBe('/t/acme/agent');
  });

  it('re-points a path already prefixed with a different tenant', () => {
    expect(buildTenantPath('/t/other/agent', 'acme')).toBe('/t/acme/t/other/agent');
  });

  it('leaves relative paths and empty tenants alone', () => {
    expect(buildTenantPath('agent', 'acme')).toBe('agent');
    expect(buildTenantPath('/agent', null)).toBe('/agent');
  });

  it('round-trips with stripTenantPath', () => {
    expect(stripTenantPath(buildTenantPath('/agent/1', 'acme'))).toBe('/agent/1');
  });
});

describe('reserved slugs', () => {
  it('reserves the tenant prefix itself', () => {
    // Without this, `/t/t/...` and a workspace literally named `t` both become
    // ambiguous with the prefix.
    expect(isReservedSlug('t')).toBe(true);
  });

  it('reserves every workspace-mirrored segment', () => {
    for (const segment of [
      'agent',
      'community',
      'eval',
      'group',
      'image',
      'memory',
      'page',
      'project',
      'resource',
      'settings',
      'task',
      'video',
    ]) {
      expect(isReservedSlug(segment)).toBe(true);
    }
  });

  it('reserves the personal-only surfaces', () => {
    for (const segment of [
      'apps',
      'invite',
      'onboarding',
      'me',
      'share',
      'devtools',
      'desktop-onboarding',
    ]) {
      expect(isReservedSlug(segment)).toBe(true);
    }
  });

  it('reserves auth and top-level routes that a slug would shadow', () => {
    for (const segment of ['signin', 'signup', 'oauth', 'oidc', 'verify', 'downloads', 'profile']) {
      expect(isReservedSlug(segment)).toBe(true);
    }
  });

  it('compares case-insensitively', () => {
    expect(isReservedSlug('Agent')).toBe(true);
  });

  it('allows an ordinary company slug', () => {
    expect(isRegistrableSlug('acme')).toBe(true);
    expect(isRegistrableSlug('acme-corp')).toBe(true);
  });

  it('rejects reserved and malformed slugs at registration', () => {
    expect(isRegistrableSlug('agent')).toBe(false);
    expect(isRegistrableSlug('Acme')).toBe(false);
    expect(isRegistrableSlug('-acme')).toBe(false);
  });

  it('has no empty entries', () => {
    for (const slug of RESERVED_SLUGS) expect(slug.length).toBeGreaterThan(0);
  });
});

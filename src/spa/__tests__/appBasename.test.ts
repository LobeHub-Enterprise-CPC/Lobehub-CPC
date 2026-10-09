import { describe, expect, it } from 'vitest';

import { DEBUG_PROXY_BASE, resolveAppBasename } from '../appBasename';

describe('resolveAppBasename', () => {
  it('returns no basename for an ordinary url', () => {
    expect(resolveAppBasename({ pathname: '/agent/123' })).toEqual({
      basename: undefined,
      tenantSlug: null,
    });
  });

  it('reads the tenant prefix as a basename', () => {
    expect(resolveAppBasename({ pathname: '/t/acme/agent/123' })).toEqual({
      basename: '/t/acme',
      tenantSlug: 'acme',
    });
  });

  it('handles the tenant root', () => {
    expect(resolveAppBasename({ pathname: '/t/acme' })).toEqual({
      basename: '/t/acme',
      tenantSlug: 'acme',
    });
  });

  it('keeps the existing debug-proxy behaviour', () => {
    expect(resolveAppBasename({ pathname: `${DEBUG_PROXY_BASE}/agent` })).toEqual({
      basename: DEBUG_PROXY_BASE,
      tenantSlug: null,
    });
    expect(resolveAppBasename({ debugProxy: true, pathname: '/agent' })).toEqual({
      basename: DEBUG_PROXY_BASE,
      tenantSlug: null,
    });
  });

  it('composes the proxy prefix with the tenant prefix, proxy outermost', () => {
    expect(resolveAppBasename({ pathname: `${DEBUG_PROXY_BASE}/t/acme/agent` })).toEqual({
      basename: `${DEBUG_PROXY_BASE}/t/acme`,
      tenantSlug: 'acme',
    });
  });

  it('composes when the proxy is forced by the flag rather than the path', () => {
    expect(resolveAppBasename({ debugProxy: true, pathname: '/t/acme/agent' })).toEqual({
      basename: `${DEBUG_PROXY_BASE}/t/acme`,
      tenantSlug: 'acme',
    });
  });

  it('does not treat a malformed tenant slug as a basename', () => {
    // Better to 404 visibly than to boot a router whose basename does not match
    // the url — that renders an empty app with no error.
    expect(resolveAppBasename({ pathname: '/t/UPPER/agent' })).toEqual({
      basename: undefined,
      tenantSlug: null,
    });
  });

  it('does not mistake a bare /t for a tenant', () => {
    expect(resolveAppBasename({ pathname: '/t' }).tenantSlug).toBeNull();
  });

  it('leaves a workspace slug in the path for the route tree to match', () => {
    // The workspace subtree must still see its own segment; only the tenant
    // prefix is lifted out.
    const { basename } = resolveAppBasename({ pathname: '/t/acme/my-workspace/agent' });
    expect(basename).toBe('/t/acme');
  });
});

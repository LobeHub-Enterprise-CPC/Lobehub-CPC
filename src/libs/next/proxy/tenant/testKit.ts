import { NextRequest } from 'next/server';
import { afterEach, beforeEach, expect, vi } from 'vitest';

import {
  handleNavigationRedirect,
  NAVIGATION_REDIRECT_HEADER,
  NAVIGATION_REDIRECT_PATH,
} from '../navigationRedirect';

/**
 * Shared doubles for the proxy's tenant layer. A test file registers the `vi.mock` calls
 * (they are hoisted per file) with the factories below and calls `useTenantMocks()`.
 */
export const mocks = {
  accountOrganizations: vi.fn(),
  enterSlug: vi.fn(),
  findHost: vi.fn(),
  remembered: vi.fn(),
  findSlug: vi.fn(),
  getSession: vi.fn(),
  getTenantAuth: vi.fn(),
  desktopSelection: vi.fn(),
};

export const sessionDataCookie = (name: string) => ({
  sessionData: {
    name,
    attributes: { httpOnly: true, path: '/t/acme', sameSite: 'lax', secure: false },
  },
});

export const endpointsModule = () => ({
  endpointHosts: () => ({ appUrl: 'http://localhost:3010', internalUrl: 'http://internal:3210' }),
  findHostEndpoint: (host: string) => mocks.findHost(host),
  getTenantEndpoints: () => ({ get: mocks.remembered }),
  findSlugEndpoint: (slug: string) => mocks.findSlug(slug),
});
export const desktopModule = () => ({ selectDesktopTenant: mocks.desktopSelection });
export const accountModule = () => ({
  findAccountOrganizations: mocks.accountOrganizations,
});
export const authModule = () => ({ getTenantAuth: () => mocks.getTenantAuth() });
export const runtimeModule = () => ({ getTenantRuntime: () => ({ enterSlug: mocks.enterSlug }) });

process.env.KEY_VAULTS_SECRET = 'proxy-test-master-secret';

/** Registers the per-test reset every tenant proxy test relies on. */
export const useTenantMocks = () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    mocks.accountOrganizations.mockReset().mockResolvedValue([]);
    mocks.desktopSelection
      .mockReset()
      .mockResolvedValue({ url: 'https://chat.example.com/oidc/auth?state=authorized' });
    mocks.findHost.mockReset().mockResolvedValue(null);
    mocks.remembered
      .mockReset()
      .mockResolvedValue({ activeUrl: 'http://localhost:3010/t/acme', appliedVersion: 1 });
    mocks.findSlug.mockReset().mockImplementation(async (slug: string) =>
      slug === 'acme'
        ? {
            slug,
            tenantId: 'tenant-1',
            state: {
              activeUrl: 'http://localhost:3010/t/acme',
              endpoints: [{ kind: 'default', host: null, active: true }],
            },
          }
        : null,
    );
    mocks.getTenantAuth.mockReset().mockResolvedValue({
      $context: Promise.resolve({ authCookies: sessionDataCookie('lh_x.session_data') }),
      api: { getSession: mocks.getSession },
    });
    // Better Auth changes the result shape when returnHeaders is true.
    mocks.getSession
      .mockReset()
      .mockResolvedValue({ headers: new Headers(), response: { user: { id: 'user-1' } } });
    mocks.enterSlug.mockReset().mockImplementation(async (slug: string) => {
      if (slug === 'acme')
        return {
          release: async () => {},
          scope: {
            slug,
            tenantId: 'tenant-1',
            endpoint: {
              basePath: '/t/acme',
              publicUrl: 'http://localhost:3010/t/acme',
              version: 1,
            },
          },
        };
      throw Object.assign(new Error('not found'), { code: 'TENANT_NOT_FOUND' });
    });
  });
};

export const documentNavigation = (
  path: string,
  headers: Record<string, string> = {},
  method = 'GET',
) =>
  new NextRequest(`http://localhost:3010${path}`, {
    method,
    headers: { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', ...headers },
  });

/**
 * Next rebuilds every middleware `Location` and drops its empty fragment, so the proxy rewrites to
 * the signed-navigation route handler (see `navigationRedirect.ts`). This follows that transport
 * end to end and asserts the browser-facing 302 and its exact target.
 */
export const expectFragmentRedirect = async (response: Response, location: string) => {
  expect(response.headers.get('location')).toBeNull();
  const rewrite = response.headers.get('x-middleware-rewrite');
  expect(rewrite).not.toBeNull();
  expect(new URL(rewrite!).pathname).toBe(NAVIGATION_REDIRECT_PATH);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(response.headers.get('referrer-policy')).toBe('no-referrer');

  const forwarded = new Headers();
  for (const name of response.headers.get('x-middleware-override-headers')?.split(',') ?? []) {
    const key = name.trim();
    const value = response.headers.get(`x-middleware-request-${key}`);
    if (key && value !== null) forwarded.set(key, value);
  }
  expect(forwarded.get(NAVIGATION_REDIRECT_HEADER)).not.toBeNull();

  const final = handleNavigationRedirect(new Request(rewrite!, { headers: forwarded }));
  expect(final.status).toBe(302);
  expect(final.headers.get('location')).toBe(location);
  expect(final.headers.get('cache-control')).toBe('private, no-store');
  expect(final.headers.get('referrer-policy')).toBe('no-referrer');
  expect(await final.text()).toBe('');
  expect(location.endsWith('#')).toBe(true);
};

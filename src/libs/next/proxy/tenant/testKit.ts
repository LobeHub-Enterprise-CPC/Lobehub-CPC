import { NextRequest } from 'next/server';
import { afterEach, beforeEach, expect, vi } from 'vitest';

/**
 * Shared doubles for the proxy's tenant layer. A test file registers the `vi.mock` calls
 * (they are hoisted per file) with the factories below and calls `useTenantMocks()`.
 */
export const mocks = {
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
 * Next rebuilds every middleware `Location` and drops its empty fragment, so these navigations are
 * answered as a page whose meta refresh carries the target (see `navigationRedirect.ts`).
 */
export const expectFragmentRedirect = async (response: Response, location: string) => {
  expect(response.status).toBe(200);
  expect(response.headers.get('location')).toBeNull();
  expect(response.headers.get('x-middleware-rewrite')).toBeNull();
  expect(await response.text()).toContain(`content="0;url=${location.replaceAll('&', '&amp;')}"`);
  expect(location.endsWith('#')).toBe(true);
};

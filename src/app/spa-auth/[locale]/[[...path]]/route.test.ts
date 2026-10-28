// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { GET } from './route';

const mocks = vi.hoisted(() => ({
  tenant: undefined as { basePath: string; slug: string } | undefined,
}));
const template =
  '<html><script>window.__SERVER_CONFIG__ = undefined; /* SERVER_CONFIG */</script></html>';
vi.mock('@/envs/app', () => ({ appEnv: { APP_URL: 'https://app.example.com/deployment/' } }));
vi.mock('@/envs/auth', () => ({ authEnv: { ENABLE_OIDC: false } }));
vi.mock('@/server/modules/Tenant/pageBootstrap', () => ({
  getTenantPageBootstrap: async () => mocks.tenant,
}));
vi.mock('@/server/modules/Tenant/gate', () => ({ routedTenantSlug: () => undefined }));
vi.mock('@/server/globalConfig/getServerAuthConfig', () => ({
  getServerAuthConfig: async () => ({}),
}));
vi.mock('@/server/featureFlags', () => ({
  getServerFeatureFlagsFromRuntimeConfig: async () => ({}),
}));
vi.mock('@/auth', () => ({ getTenantSsoProviders: vi.fn() }));
vi.mock('@/libs/spaHtml', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  buildAnalyticsConfig: () => ({}),
  fetchViteDevTemplate: async () => template,
}));
vi.mock('/src/app/spa-auth/authHtmlTemplate', () => ({ authHtmlTemplate: template }));
vi.mock('./seoMeta', () => ({ buildSeoMeta: async () => '' }));

describe('auth shell deployment navigation configuration', () => {
  it.each([{ path: [] }, { path: ['signin'] }])(
    'injects the deployment origin and protects privacy for %j',
    async ({ path }) => {
      const response = await GET(new Request('https://chat.example.com/spa-auth/en-US/signin'), {
        params: Promise.resolve({ locale: 'en-US', path }),
      });
      expect(await response.text()).toContain('"appUrl":"https://app.example.com"');
      expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
      expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    },
  );
});

describe('desktop discovery presentation state', () => {
  it.each(['ready', 'invalid', 'expired', 'unavailable'])(
    'embeds only the %s status on the tenantless auth index',
    async (status) => {
      const state = 'a'.repeat(32);
      const challenge = 'B'.repeat(43);
      const response = await GET(
        new Request(
          `https://app.example.com/spa-auth/en-US/?state=${state}&code_challenge=${challenge}`,
          { headers: { 'x-lobe-desktop-flow': status } },
        ),
        { params: Promise.resolve({ locale: 'en-US', path: [] }) },
      );
      const html = await response.text();
      expect(html).toContain(`"desktopFlow":{"status":"${status}"}`);
      expect(html).not.toContain(state);
      expect(html).not.toContain(challenge);
    },
  );
  it.each([undefined, '', 'READY', 'forged'])(
    'does not expose an absent or malformed marker: %s',
    async (status) => {
      const response = await GET(
        new Request('https://app.example.com/spa-auth/en-US/?desktopInvalid=1', {
          headers: status === undefined ? {} : { 'x-lobe-desktop-flow': status },
        }),
        { params: Promise.resolve({ locale: 'en-US', path: [] }) },
      );
      expect(await response.text()).not.toContain('desktopFlow');
    },
  );
  it('does not spread the marker into sign-in or tenant pages', async () => {
    const request = new Request('https://app.example.com/spa-auth/en-US/', {
      headers: { 'x-lobe-desktop-flow': 'ready' },
    });
    const signIn = await GET(request, {
      params: Promise.resolve({ locale: 'en-US', path: ['signin'] }),
    });
    expect(await signIn.text()).not.toContain('desktopFlow');
    mocks.tenant = { basePath: '/orgs/acme', slug: 'acme' };
    try {
      const tenantPage = await GET(request, {
        params: Promise.resolve({ locale: 'en-US', path: [] }),
      });
      expect(await tenantPage.text()).not.toContain('desktopFlow');
    } finally {
      mocks.tenant = undefined;
    }
  });
});

describe('remembered-account presentation flag', () => {
  it('embeds rootAccount only for the tenantless root marked by the proxy', async () => {
    const response = await GET(
      new Request('https://app.example.com/spa-auth/en-US/', {
        headers: { 'x-lobe-root-account': '1' },
      }),
      { params: Promise.resolve({ locale: 'en-US', path: [] }) },
    );
    const html = await response.text();
    expect(html).toContain('"rootAccount":true');
    expect(html).not.toContain('desktopFlow');
  });

  it.each([
    ['a sign-in page', ['signin'] as string[], undefined, '1'],
    ['a tenant page', [] as string[], { basePath: '/orgs/acme', slug: 'acme' }, '1'],
    ['an absent flag', [] as string[], undefined, undefined],
    ['a forged flag', [] as string[], undefined, 'true'],
  ])('does not expose rootAccount on %s', async (_name, path, tenant, flag) => {
    mocks.tenant = tenant;
    try {
      const response = await GET(
        new Request('https://app.example.com/spa-auth/en-US/', {
          headers: flag === undefined ? {} : { 'x-lobe-root-account': flag },
        }),
        { params: Promise.resolve({ locale: 'en-US', path }) },
      );
      expect(await response.text()).not.toContain('rootAccount');
    } finally {
      mocks.tenant = undefined;
    }
  });
});

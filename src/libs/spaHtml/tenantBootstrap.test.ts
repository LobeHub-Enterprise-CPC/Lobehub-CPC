// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import type * as AppEnvironment from '@/envs/app';
import { signTenantRoute, TENANT_ROUTE_HEADER } from '@/server/modules/Tenant/routeHeader';

const mocks = vi.hoisted(() => ({
  activeUrl: 'https://chat.example.com',
  gateRefuses: false,
  inTenant: false,
}));
vi.mock('@/envs/app', async (importOriginal) => {
  const original = await importOriginal<typeof AppEnvironment>();
  return {
    ...original,
    appEnv: { ...original.appEnv, APP_URL: 'https://app.example.com/deployment/' },
  };
});
const template =
  '<html><head><!--SEO_META--></head><script>window.__SERVER_CONFIG__ = undefined; /* SERVER_CONFIG */</script></html>';
vi.mock('@/server/modules/Tenant/endpoints', () => ({
  findSlugEndpoint: async () => ({
    name: 'Acme </script> & Co.',
    slug: 'acme',
    tenantId: 'tenant-1',
    state: { activeUrl: mocks.activeUrl, appliedVersion: 2 },
  }),
}));
vi.mock('@/libs/spaHtml', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchViteDevTemplate: async () => template,
  buildAnalyticsConfig: () => ({}),
}));
vi.mock('@/libs/i18n/serverTranslation', () => ({
  translation: async () => ({ t: (key: string) => key }),
}));
vi.mock('@/server/globalConfig', () => ({ getServerGlobalConfig: async () => ({}) }));
// Tenant settings are only readable inside the tenant the request was routed to.
vi.mock('@/server/globalConfig/getServerAuthConfig', () => ({
  getServerAuthConfig: async () => (mocks.inTenant ? { disableEmailPassword: true } : {}),
}));
vi.mock('@/auth', () => ({
  getTenantSsoProviders: async () => {
    if (!mocks.inTenant) throw new Error('TENANT_REQUIRED');
    return [{ providerId: 'acme-oidc' }];
  },
}));
vi.mock('@/server/modules/Tenant/gate', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  withTenantRequest:
    (
      handler: (request: Request) => Promise<Response>,
      { refuse }: { refuse: (refusal: Error, request: Request) => Promise<Response> },
    ) =>
    async (request: Request) => {
      if (mocks.gateRefuses) return refuse(new Error('TENANT_FROZEN'), request);
      mocks.inTenant = true;
      try {
        return await handler(request);
      } finally {
        mocks.inTenant = false;
      }
    },
}));
vi.mock('@/server/featureFlags', () => ({
  getServerFeatureFlagsFromRuntimeConfig: async () => ({}),
}));
vi.mock('/src/app/spa-share/shareHtmlTemplate', () => ({ shareHtmlTemplate: template }));
vi.mock('/src/app/spa-workbench/workbenchHtmlTemplate', () => ({
  workbenchHtmlTemplate: template,
}));
vi.mock('/src/app/spa-auth/authHtmlTemplate', () => ({ authHtmlTemplate: template }));
vi.mock('/src/app/spa/[variants]/[[...path]]/spaHtmlTemplates', () => ({
  desktopHtmlTemplate: template,
  mobileHtmlTemplate: template,
}));
process.env.KEY_VAULTS_SECRET = 'spa-bootstrap-test-secret';
describe('all server SPA shells', () => {
  it.each(['web', 'auth', 'share', 'workbench'])(
    'injects canonical root bootstrap and issuer in %s HTML',
    async (shell) => {
      const request = new Request('https://chat.example.com/spa', {
        headers: { [TENANT_ROUTE_HEADER]: signTenantRoute('acme')! },
      });
      let response: Response;
      if (shell === 'web') {
        const { GET } = await import('../../app/spa/[variants]/[[...path]]/route');
        response = await GET(request, {
          params: Promise.resolve({ variants: 'en-US__0', path: ['agent'] }),
        });
      } else if (shell === 'auth') {
        const { GET } = await import('../../app/spa-auth/[locale]/[[...path]]/route');
        response = await GET(request, {
          params: Promise.resolve({ locale: 'en-US', path: ['signin'] }),
        });
      } else if (shell === 'share') {
        const { GET } = await import('../../app/spa-share/[locale]/[[...path]]/route');
        response = await GET(request, { params: Promise.resolve({ locale: 'en-US' }) });
      } else {
        const { GET } = await import('../../app/spa-workbench/[locale]/[[...path]]/route');
        response = await GET(request, { params: Promise.resolve({ locale: 'en-US' }) });
      }
      const html = await response.text();
      expect(html).toContain('"basePath":""');
      expect(html).toContain('"slug":"acme"');
      // The display name is tenant-controlled text and must not break out of the script tag.
      expect(html).toContain(String.raw`"name":"Acme \u003c/script\u003e \u0026 Co."`);
      if (shell === 'web' || shell === 'auth')
        expect(html).toContain('"appUrl":"https://app.example.com"');
      expect(html).toContain('"oidcIssuer":"https://chat.example.com/oidc"');
      expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    },
  );
});

describe('auth SPA shell', () => {
  const renderSignIn = async () => {
    const { GET } = await import('../../app/spa-auth/[locale]/[[...path]]/route');
    const request = new Request('https://chat.example.com/spa', {
      headers: { [TENANT_ROUTE_HEADER]: signTenantRoute('acme')! },
    });
    const response = await GET(request, {
      params: Promise.resolve({ locale: 'en-US', path: ['signin'] }),
    });
    return response.text();
  };

  it("embeds the routed tenant's login methods and SSO providers", async () => {
    mocks.gateRefuses = false;
    const html = await renderSignIn();

    expect(html).toContain('"disableEmailPassword":true');
    expect(html).toContain('"oAuthSSOProviders":["acme-oidc"]');
  });

  it('still renders the sign-in page when the tenant cannot be entered', async () => {
    mocks.gateRefuses = true;
    const html = await renderSignIn();
    mocks.gateRefuses = false;

    expect(html).toContain('"slug":"acme"');
    expect(html).not.toContain('acme-oidc');
  });
});

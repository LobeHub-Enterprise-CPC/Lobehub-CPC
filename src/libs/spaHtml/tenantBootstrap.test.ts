// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { signTenantRoute, TENANT_ROUTE_HEADER } from '@/server/modules/Tenant/routeHeader';

const mocks = vi.hoisted(() => ({ activeUrl: 'https://chat.example.com' }));
const template =
  '<html><head><!--SEO_META--></head><script>window.__SERVER_CONFIG__ = undefined; /* SERVER_CONFIG */</script></html>';
vi.mock('@/server/modules/Tenant/endpoints', () => ({
  findSlugEndpoint: async () => ({
    slug: 'acme',
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
vi.mock('@/server/globalConfig/getServerAuthConfig', () => ({ getServerAuthConfig: () => ({}) }));
vi.mock('@/config/featureFlags', () => ({ getServerFeatureFlagsValue: () => ({}) }));
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
      expect(html).toContain('"oidcIssuer":"https://chat.example.com/oidc"');
      expect(response.headers.get('Cache-Control')).not.toContain('public');
    },
  );
});

import { getTenantSsoProviders } from '@/auth';
import { appEnv } from '@/envs/app';
import { authEnv } from '@/envs/auth';
import { buildAnalyticsConfig, fetchViteDevTemplate, renderSpaHtml } from '@/libs/spaHtml';
import { type Locales, normalizeLocale } from '@/locales/resources';
import { getServerFeatureFlagsFromRuntimeConfig } from '@/server/featureFlags';
import { getServerAuthConfig } from '@/server/globalConfig/getServerAuthConfig';
import { routedTenantSlug, withTenantRequest } from '@/server/modules/Tenant/gate';
import { getTenantPageBootstrap } from '@/server/modules/Tenant/pageBootstrap';
import { type AuthSPAServerConfig } from '@/types/spaServerConfig';

import { buildSeoMeta } from './seoMeta';

export function generateStaticParams() {
  const staticLocales: Locales[] = ['en-US', 'zh-CN'];

  return staticLocales.map((locale) => ({ locale }));
}

const isDev = process.env.NODE_ENV === 'development';

async function getTemplate(): Promise<string> {
  if (isDev) return fetchViteDevTemplate('/index.auth.html');

  const { authHtmlTemplate } = await import('../../authHtmlTemplate');

  return authHtmlTemplate;
}

interface RouteContext {
  params: Promise<{ locale: string; path?: string[] }>;
}

const renderAuthPage = async (
  request: Request,
  { params }: RouteContext,
  oAuthSSOProviders?: string[],
) => {
  const { locale: rawLocale, path } = await params;
  const locale = normalizeLocale(rawLocale);

  const tenant = await getTenantPageBootstrap(request);
  const authConfig: AuthSPAServerConfig = {
    tenant,
    analyticsConfig: buildAnalyticsConfig(),
    config: {
      ...(await getServerAuthConfig()),
      ...(oAuthSSOProviders ? { oAuthSSOProviders } : {}),
      ...(tenant ? { oidcIssuer: `${tenant.publicUrl}/oidc` } : {}),
    },
    enableOIDC: authEnv.ENABLE_OIDC,
    featureFlags: await getServerFeatureFlagsFromRuntimeConfig(),
    globalCDN: appEnv.CDN_USE_GLOBAL,
  };

  const template = await getTemplate();
  const pathname = `/${(path ?? []).join('/')}`;
  const seoMeta = await buildSeoMeta(locale, pathname);

  return renderSpaHtml(template, { seoMeta, serverConfig: authConfig });
};

export async function GET(request: Request, context: RouteContext) {
  if (!routedTenantSlug(request)) return renderAuthPage(request, context);

  // Rendered inside the routed tenant, so the login methods, feature flags and
  // SSO providers are its own (spec FR-TS-07, A8; ids only, as `spa-config`).
  // A tenant that cannot be entered still gets a sign-in page, without them.
  return withTenantRequest(
    async (tenantRequest: Request) =>
      renderAuthPage(
        tenantRequest,
        context,
        (await getTenantSsoProviders()).map((provider) => provider.providerId),
      ),
    { refuse: (_refusal, refusedRequest) => renderAuthPage(refusedRequest, context) },
  )(request);
}

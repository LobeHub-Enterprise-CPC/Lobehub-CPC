import { getTenantSsoProviders } from '@/auth';
import { appEnv } from '@/envs/app';
import { authEnv } from '@/envs/auth';
import { buildAnalyticsConfig, fetchViteDevTemplate, renderSpaHtml } from '@/libs/spaHtml';
import { normalizeLocale } from '@/locales/resources';
import { getServerFeatureFlagsFromRuntimeConfig } from '@/server/featureFlags';
import { getServerAuthConfig } from '@/server/globalConfig/getServerAuthConfig';
import { routedTenantSlug, withTenantRequest } from '@/server/modules/Tenant/gate';
import { getTenantPageBootstrap } from '@/server/modules/Tenant/pageBootstrap';
import {
  DESKTOP_FLOW_HEADER,
  readDesktopFlowStatus,
} from '@/server/services/tenantDiscovery/navigation';
import { type AuthSPAServerConfig } from '@/types/spaServerConfig';

import { buildSeoMeta } from './seoMeta';

// The shell is rendered per request: tenant bootstrap, login methods and feature
// flags come from the signed tenant route header, which a prerendered route
// handler cannot read (production build: DYNAMIC_SERVER_USAGE -> 500). Hence no
// static params; the proxy rewrite supplies any locale/variant.
export const dynamic = 'force-dynamic';

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
  // This marker controls presentation only, never authorization. Direct shell requests
  // cannot gain a tenant or bypass select's independent Origin/flow checks with it.
  const desktopStatus =
    !tenant && !path?.length
      ? readDesktopFlowStatus(request.headers.get(DESKTOP_FLOW_HEADER))
      : undefined;
  const authConfig: AuthSPAServerConfig = {
    ...(desktopStatus ? { desktopFlow: { status: desktopStatus } } : {}),
    tenant,
    appUrl: new URL(appEnv.APP_URL).origin,
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

  const response = renderSpaHtml(template, { seoMeta, serverConfig: authConfig });
  response.headers.set('Referrer-Policy', 'no-referrer');
  return response;
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

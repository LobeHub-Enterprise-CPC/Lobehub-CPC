import { appEnv } from '@/envs/app';
import { authEnv } from '@/envs/auth';
import { buildAnalyticsConfig, fetchViteDevTemplate, renderSpaHtml } from '@/libs/spaHtml';
import { type Locales, normalizeLocale } from '@/locales/resources';
import { getServerFeatureFlagsFromRuntimeConfig } from '@/server/featureFlags';
import { getServerAuthConfig } from '@/server/globalConfig/getServerAuthConfig';
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

export async function GET(
  request: Request,
  { params }: { params: Promise<{ locale: string; path?: string[] }> },
) {
  const { locale: rawLocale, path } = await params;
  const locale = normalizeLocale(rawLocale);

  const tenant = await getTenantPageBootstrap(request);
  const authConfig: AuthSPAServerConfig = {
    tenant,
    analyticsConfig: buildAnalyticsConfig(),
    config: {
      ...getServerAuthConfig(),
      ...(tenant ? { oidcIssuer: `${tenant.publicUrl}/oidc` } : {}),
    },
    enableOIDC: authEnv.ENABLE_OIDC,
    // Rendered outside any tenant scope: business builds embed the product defaults.
    featureFlags: await getServerFeatureFlagsFromRuntimeConfig(),
    globalCDN: appEnv.CDN_USE_GLOBAL,
  };

  const template = await getTemplate();
  const pathname = `/${(path ?? []).join('/')}`;
  const seoMeta = await buildSeoMeta(locale, pathname);

  return renderSpaHtml(template, { seoMeta, serverConfig: authConfig });
}

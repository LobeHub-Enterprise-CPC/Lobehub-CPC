import { BRANDING_NAME } from '@lobechat/business-const';

import { appEnv } from '@/envs/app';
import { fileEnv } from '@/envs/file';
import { pythonEnv } from '@/envs/python';
import { buildAnalyticsConfig, fetchViteDevTemplate, renderSpaHtml } from '@/libs/spaHtml';
import { normalizeLocale } from '@/locales/resources';
import { getServerFeatureFlagsFromRuntimeConfig } from '@/server/featureFlags';
import { getServerGlobalConfig } from '@/server/globalConfig';
import { getTenantPageBootstrap } from '@/server/modules/Tenant/pageBootstrap';
import { type SPAClientEnv, type SPAServerConfig } from '@/types/spaServerConfig';

// The shell is rendered per request: tenant bootstrap, login methods and feature
// flags come from the signed tenant route header, which a prerendered route
// handler cannot read (production build: DYNAMIC_SERVER_USAGE -> 500). Hence no
// static params; the proxy rewrite supplies any locale/variant.
export const dynamic = 'force-dynamic';

const isDev = process.env.NODE_ENV === 'development';

async function getTemplate(): Promise<string> {
  if (isDev) return fetchViteDevTemplate('/index.workbench.html');

  const { workbenchHtmlTemplate } = await import('../../workbenchHtmlTemplate');

  return workbenchHtmlTemplate;
}

function buildClientEnv(): SPAClientEnv {
  return {
    marketBaseUrl: appEnv.MARKET_BASE_URL,
    marketSkillInstallBaseUrl: appEnv.MARKET_SKILL_INSTALL_BASE_URL,
    pyodideIndexUrl: pythonEnv.NEXT_PUBLIC_PYODIDE_INDEX_URL,
    pyodidePipIndexUrl: pythonEnv.NEXT_PUBLIC_PYODIDE_PIP_INDEX_URL,
    s3FilePath: fileEnv.NEXT_PUBLIC_S3_FILE_PATH,
  };
}

const buildSeoMeta = (locale: string) =>
  [
    `<title>${BRANDING_NAME}</title>`,
    '<meta name="robots" content="noindex, nofollow" />',
    `<meta property="og:locale" content="${locale}" />`,
  ].join('\n    ');

export async function GET(
  request: Request,
  { params }: { params: Promise<{ locale: string; path?: string[] }> },
) {
  const { locale: rawLocale } = await params;
  const locale = normalizeLocale(rawLocale);

  const tenant = await getTenantPageBootstrap(request);
  const spaConfig: SPAServerConfig = {
    tenant,
    analyticsConfig: buildAnalyticsConfig(),
    clientEnv: buildClientEnv(),
    config: {
      ...(await getServerGlobalConfig()),
      ...(tenant ? { oidcIssuer: `${tenant.publicUrl}/oidc` } : {}),
    },
    // Rendered outside any tenant scope: business builds embed the product
    // defaults here, and the tenant's own flags arrive with the server config.
    featureFlags: await getServerFeatureFlagsFromRuntimeConfig(),
    isMobile: true,
  };

  const template = await getTemplate();

  return renderSpaHtml(template, { seoMeta: buildSeoMeta(locale), serverConfig: spaConfig });
}

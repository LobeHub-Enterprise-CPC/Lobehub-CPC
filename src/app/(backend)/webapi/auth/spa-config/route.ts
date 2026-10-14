import { requireTenantScope } from '@lobechat/database/tenant';

import { getTenantSsoProviders } from '@/auth';
import { appEnv } from '@/envs/app';
import { authEnv } from '@/envs/auth';
import { buildAnalyticsConfig } from '@/libs/spaHtml';
import { getServerFeatureFlagsFromRuntimeConfig } from '@/server/featureFlags';
import { getServerAuthConfig } from '@/server/globalConfig/getServerAuthConfig';
import { withTenantRequest } from '@/server/modules/Tenant/gate';

// The prerendered auth micro app ships without any deployment's config baked in;
// its worker reads this to fill `window.__SERVER_CONFIG__` before serving a page.
//
// Deliberately narrower than `AuthSPAServerConfig`: this endpoint is public and
// unauthenticated, so it carries only the fields the auth pages actually read.
// `enableBusinessFeatures` is not among them — it is a build-time constant.
const handleGet = async () => {
  const { disableEmailPassword, enableEmailVerification, enableMagicLink } = getServerAuthConfig();
  // The tenant's own providers (spec A8); ids only, never their configuration.
  const oAuthSSOProviders = (await getTenantSsoProviders()).map((provider) => provider.providerId);
  const { endpoint, slug } = requireTenantScope();

  return Response.json(
    {
      tenant: {
        basePath: endpoint.basePath,
        publicUrl: endpoint.publicUrl,
        slug,
      },
      analyticsConfig: buildAnalyticsConfig(),
      config: {
        disableEmailPassword,
        enableEmailVerification,
        enableMagicLink,
        oAuthSSOProviders,
      },
      enableOIDC: authEnv.ENABLE_OIDC,
      featureFlags: await getServerFeatureFlagsFromRuntimeConfig(),
      globalCDN: appEnv.CDN_USE_GLOBAL,
    },
    {
      headers: {
        // Per tenant: a shared cache must not hand one tenant's providers to another.
        'Cache-Control': 'private, no-store',
      },
    },
  );
};

export const GET = withTenantRequest(handleGet);

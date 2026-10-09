import { getTenantSsoProviders } from '@/auth';
import { getServerFeatureFlagsValue } from '@/config/featureFlags';
import { appEnv } from '@/envs/app';
import { authEnv } from '@/envs/auth';
import { buildAnalyticsConfig } from '@/libs/spaHtml';
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

  return Response.json(
    {
      analyticsConfig: buildAnalyticsConfig(),
      config: {
        disableEmailPassword,
        enableEmailVerification,
        enableMagicLink,
        oAuthSSOProviders,
      },
      enableOIDC: authEnv.ENABLE_OIDC,
      featureFlags: getServerFeatureFlagsValue(),
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

import { ENABLE_BUSINESS_FEATURES } from '@lobechat/business-const';

import { appEnv } from '@/envs/app';
import { authEnv } from '@/envs/auth';
import { type GlobalServerConfig } from '@/types/serverConfig';

export const getServerAuthConfig = (): GlobalServerConfig => {
  return {
    aiProvider: {},
    disableEmailPassword: authEnv.AUTH_DISABLE_EMAIL_PASSWORD,
    enableBusinessFeatures: ENABLE_BUSINESS_FEATURES,
    enableEmailVerification: authEnv.AUTH_EMAIL_VERIFICATION,
    enableMagicLink: authEnv.AUTH_ENABLE_MAGIC_LINK,
    enableMarketTrustedClient: !!(
      appEnv.MARKET_TRUSTED_CLIENT_SECRET && appEnv.MARKET_TRUSTED_CLIENT_ID
    ),
    // SSO providers belong to a tenant (`sso_providers`, spec A8); the auth
    // config endpoint fills them in for the tenant being signed in to.
    oAuthSSOProviders: [],
    telemetry: {},
  };
};

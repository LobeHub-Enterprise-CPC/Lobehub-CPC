import { authEnv } from '@/envs/auth';

import { buildOidcConfig } from '../helpers';
import { type GenericProviderDefinition } from '../types';

const provider: GenericProviderDefinition<{
  AUTH_GENERIC_OIDC_ID: string;
  AUTH_GENERIC_OIDC_ISSUER: string;
  AUTH_GENERIC_OIDC_SECRET: string;
}> = {
  build: (env) =>
    buildOidcConfig({
      clientId: env.AUTH_GENERIC_OIDC_ID,
      clientSecret: env.AUTH_GENERIC_OIDC_SECRET,
      issuer: env.AUTH_GENERIC_OIDC_ISSUER,
      providerId: 'generic-oidc',
    }),
  checkEnvs: () => {
    return !!(
      authEnv.AUTH_GENERIC_OIDC_ID &&
      authEnv.AUTH_GENERIC_OIDC_SECRET &&
      authEnv.AUTH_GENERIC_OIDC_ISSUER
    )
      ? {
          AUTH_GENERIC_OIDC_ID: authEnv.AUTH_GENERIC_OIDC_ID,
          AUTH_GENERIC_OIDC_ISSUER: authEnv.AUTH_GENERIC_OIDC_ISSUER,
          AUTH_GENERIC_OIDC_SECRET: authEnv.AUTH_GENERIC_OIDC_SECRET,
        }
      : false;
  },
  id: 'generic-oidc',
  type: 'generic',
};

export default provider;

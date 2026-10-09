import { serverDB } from '@/database/core/db-adaptor';
import { authEnv } from '@/envs/auth';
import { type OIDCProvider } from '@/libs/oidc-provider/provider';
import { createOIDCProvider } from '@/libs/oidc-provider/provider';

/**
 * OIDC Provider instance
 */
let provider: OIDCProvider;

/**
 * Get OIDC Provider instance
 * @returns OIDC Provider instance
 */
export const getOIDCProvider = async (): Promise<OIDCProvider> => {
  if (!provider) {
    if (!authEnv.ENABLE_OIDC) {
      throw new Error('OIDC is not enabled. Set ENABLE_OIDC=1 to enable it.');
    }

    // `serverDB` resolves the current request's tenant on every access, so one
    // provider instance serves every tenant without holding a connection.
    provider = await createOIDCProvider(serverDB);
  }

  return provider;
};

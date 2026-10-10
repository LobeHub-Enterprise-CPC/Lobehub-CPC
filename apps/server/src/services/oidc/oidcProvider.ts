import { requireTenantScope } from '@lobechat/database/tenant';

import { serverDB } from '@/database/core/db-adaptor';
import { authEnv } from '@/envs/auth';
import { createOIDCProvider, type OIDCProvider } from '@/libs/oidc-provider/provider';

// Issuers, route paths and cookies are tenant-specific. The database proxy
// resolves each operation from the request's tenant scope.
const providers = new Map<string, Promise<OIDCProvider>>();

export const getOIDCProvider = async (): Promise<OIDCProvider> => {
  if (!authEnv.ENABLE_OIDC) throw new Error('OIDC is not enabled. Set ENABLE_OIDC=1 to enable it.');
  const { slug, tenantId } = requireTenantScope();
  const key = `${tenantId}|${slug}`;
  let provider = providers.get(key);
  if (!provider) {
    provider = createOIDCProvider(serverDB, slug);
    providers.set(key, provider);
    void provider.catch((error) => {
      providers.delete(key);
      console.error('[OIDC] Provider initialization failed:', error);
    });
  }
  return provider;
};

import { listBusinessSSOProviders, managedBusinessSSO } from '@lobechat/business-auth';

import { withTenantRequest } from '@/server/modules/Tenant/gate';

export const dynamic = 'force-dynamic';

/**
 * Login metadata only. Credentials and protocol endpoints never leave the server.
 * Per tenant: a distribution's providers are the tenant's own.
 */
const handleGet = async () => {
  const headers = { 'Cache-Control': 'no-store' };
  try {
    return Response.json(
      { managed: managedBusinessSSO, providers: await listBusinessSSOProviders() },
      { headers },
    );
  } catch {
    return Response.json({ code: 'SSO_CONFIGURATION_UNAVAILABLE' }, { headers, status: 503 });
  }
};

export const GET = withTenantRequest(handleGet);

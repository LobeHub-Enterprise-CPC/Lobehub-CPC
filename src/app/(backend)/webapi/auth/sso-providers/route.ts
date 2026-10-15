import { listBusinessSSOProviders, managedBusinessSSO } from '@lobechat/business-auth';

import { getTenantSsoProviders } from '@/auth';
import { tenantRefusalResponse } from '@/server/modules/Tenant/errors';
import { withTenantRequest } from '@/server/modules/Tenant/gate';
import { toPublicSsoProvider } from '@/server/services/tenantSso';

export const dynamic = 'force-dynamic';

/**
 * The providers of the tenant being signed in to, for display: id, name, logo
 * and protocol. Credentials and protocol endpoints never leave the server.
 * Per tenant: the providers are read inside the routed tenant, so one tenant's
 * list (and its logo URLs) is never answered for another.
 */
const listProviders = async () => {
  const distribution = await listBusinessSSOProviders();
  // A distribution that manages sign-in itself owns the whole list.
  if (managedBusinessSSO) return distribution;

  const tenant = (await getTenantSsoProviders())
    .filter((provider) => provider.protocol !== 'saml')
    .map(toPublicSsoProvider);
  const taken = new Set(tenant.map((provider) => provider.id));
  return [...tenant, ...distribution.filter((provider) => !taken.has(provider.id))];
};

const handleGet = async () => {
  const headers = { 'Cache-Control': 'no-store' };
  try {
    return Response.json(
      { managed: managedBusinessSSO, providers: await listProviders() },
      { headers },
    );
  } catch (error) {
    const refusal = tenantRefusalResponse(error);
    if (refusal) return refusal;
    return Response.json({ code: 'SSO_CONFIGURATION_UNAVAILABLE' }, { headers, status: 503 });
  }
};

export const GET = withTenantRequest(handleGet);

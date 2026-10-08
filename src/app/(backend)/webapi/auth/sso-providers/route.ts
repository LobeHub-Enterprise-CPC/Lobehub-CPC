import { listBusinessSSOProviders, managedBusinessSSO } from '@lobechat/business-auth';

export const dynamic = 'force-dynamic';

/** Login metadata only. Credentials and protocol endpoints never leave the server. */
export const GET = async () => {
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

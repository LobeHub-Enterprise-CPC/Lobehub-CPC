import { useMemo } from 'react';

import { useClientDataSWR } from '@/libs/swr';

export interface SsoProviderDetail {
  displayName: string;
  logoUrl: string | null;
}

interface SsoProvidersResponse {
  providers?: Array<{ displayName?: string; id: string; logoUrl?: string | null }>;
}

const fetchSsoProviderDetails = async (): Promise<SsoProvidersResponse> => {
  const response = await fetch('/webapi/auth/sso-providers', { cache: 'no-store' });
  if (!response.ok) throw new Error('SSO providers unavailable');
  return response.json();
};

/**
 * Display name and logo of the tenant's SSO providers by provider id (the same
 * public list the sign-in page reads). Presentation only: when the list cannot
 * be read the caller keeps its built-in icon and the provider id.
 */
export const useSsoProviderDetails = (): Record<string, SsoProviderDetail> => {
  const { data } = useClientDataSWR<SsoProvidersResponse>(
    'sso-provider-details',
    fetchSsoProviderDetails,
    { revalidateOnFocus: false, shouldRetryOnError: false },
  );

  return useMemo(
    () =>
      Object.fromEntries(
        (data?.providers ?? []).map((provider) => [
          provider.id,
          { displayName: provider.displayName || provider.id, logoUrl: provider.logoUrl ?? null },
        ]),
      ),
    [data],
  );
};

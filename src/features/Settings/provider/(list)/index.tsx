'use client';

import { useMemo, useState } from 'react';
import { Navigate, useSearchParams } from 'react-router';

import { featureFlagsSelectors, useServerConfigStore } from '@/store/serverConfig';

import DesktopLayout from '../_layout/Desktop';
import MobileLayout from '../_layout/Mobile';
import ProviderDetailPage from '../detail';

const Page = (props: { mobile?: boolean }) => {
  const [SearchParams, setSearchParams] = useSearchParams();
  const [provider, setProviderState] = useState(SearchParams.get('provider') || 'all');
  // Guard: when the `provider_settings` feature flag is off (e.g. private/white-label
  // deployments), block the provider list page too — the named exports in
  // ../index.tsx carry the same gate for router-driven paths.
  const showProvider = useServerConfigStore(featureFlagsSelectors).showProvider;
  const setProvider = (provider: string) => {
    setSearchParams({ active: 'provider', provider });
    setProviderState(provider);
  };

  const { mobile } = props;
  const ProviderLayout = mobile ? MobileLayout : DesktopLayout;

  const ProviderListPage = useMemo(() => {
    return <ProviderDetailPage id={provider} onProviderSelect={setProvider} />;
  }, [provider]);

  if (!showProvider) return <Navigate replace to="/settings" />;

  return <ProviderLayout onProviderSelect={setProvider}>{ProviderListPage}</ProviderLayout>;
};

export default Page;

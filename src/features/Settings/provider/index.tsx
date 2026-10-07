'use client';

import { Flexbox } from '@lobehub/ui';
import { memo } from 'react';
import { Navigate, Outlet, useParams } from 'react-router';

import { useWorkspaceAwareNavigate } from '@/features/Workspace/useWorkspaceAwareNavigate';
import { featureFlagsSelectors, useServerConfigStore } from '@/store/serverConfig';

import DesktopLayoutContainer from './_layout/Desktop/Container';
import ProviderDetailPageComponent from './detail';
import ProviderMenu from './ProviderMenu';

// Guard: when the `provider_settings` feature flag is off (e.g. private/white-label
// deployments), block the whole provider-settings area — including deep links such as
// `/settings/provider/all` — not just the sidebar menu item.
const useProviderSettingsEnabled = () => useServerConfigStore(featureFlagsSelectors).showProvider;

// Layout component that wraps provider pages with navigation
export const ProviderLayout = memo(() => {
  const navigate = useWorkspaceAwareNavigate();
  const showProvider = useProviderSettingsEnabled();

  const handleProviderSelect = (providerKey: string) => {
    navigate(`/settings/provider/${providerKey}`);
  };

  if (!showProvider) return <Navigate replace to="/settings" />;

  return (
    <Flexbox
      horizontal
      width={'100%'}
      style={{
        maxHeight: '100%',
      }}
    >
      <ProviderMenu mobile={false} onProviderSelect={handleProviderSelect} />
      <DesktopLayoutContainer>
        <Outlet />
      </DesktopLayoutContainer>
    </Flexbox>
  );
});

ProviderLayout.displayName = 'ProviderLayout';

// Detail page component that receives providerId from route params
export const ProviderDetailPage = memo(() => {
  const params = useParams<{ providerId: string }>();
  const navigate = useWorkspaceAwareNavigate();
  const showProvider = useProviderSettingsEnabled();

  const handleProviderSelect = (providerKey: string) => {
    navigate(`/settings/provider/${providerKey}`);
  };

  if (!showProvider) return <Navigate replace to="/settings" />;

  return (
    <ProviderDetailPageComponent
      id={params.providerId ?? ''}
      onProviderSelect={handleProviderSelect}
    />
  );
});

ProviderDetailPage.displayName = 'ProviderDetailPage';

export { default } from './(list)';

import { render, screen } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { MemoryRouter, useLocation } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import type * as ConstVersion from '@/const/version';
import type * as ServerConfigStore from '@/store/serverConfig';

import WorkspaceProviderSetting from './index';

const managePermission = vi.hoisted(() => ({ allowed: true }));
const providerFlag = vi.hoisted(() => ({ showProvider: true }));

vi.mock('@/hooks/usePermission', () => ({
  usePermission: () => ({ allowed: managePermission.allowed }),
}));

// createServerConfigStore is a module-level singleton, so driving the
// provider_settings flag through ServerConfigStoreProvider props is
// order-dependent — stub the hook instead.
vi.mock('@/store/serverConfig', async (importOriginal) => {
  const actual = await importOriginal<typeof ServerConfigStore>();
  return {
    ...actual,
    useServerConfigStore: (selector: (s: unknown) => unknown) =>
      selector({ featureFlags: { showProvider: providerFlag.showProvider } }),
  };
});

vi.mock('@/business/client/hooks/useIsWorkspaceLoading', () => ({
  useIsWorkspaceLoading: () => false,
}));

vi.mock('@/const/version', async (importOriginal) => ({
  ...(await importOriginal<typeof ConstVersion>()),
  isCustomBranding: false,
}));

vi.mock('@/features/Settings/provider/_layout/Desktop', () => ({
  default: ({ children }: PropsWithChildren) => <>{children}</>,
}));

vi.mock('@/features/Settings/provider/_layout/Mobile', () => ({
  default: ({ children }: PropsWithChildren) => <>{children}</>,
}));

vi.mock('@/features/Settings/provider/detail', async () => {
  const { useSettingsContext } = await import('@/features/Settings/Layout/ContextProvider');

  const ProviderDetail = () => {
    const { showOpenAIApiKey, showOpenAIProxyUrl } = useSettingsContext();

    return (
      <div data-testid="provider-context">
        {String(showOpenAIApiKey)}:{String(showOpenAIProxyUrl)}
      </div>
    );
  };

  return { default: ProviderDetail };
});

const renderPage = (providerId: string) =>
  render(
    <MemoryRouter initialEntries={[`/?provider=${providerId}`]}>
      <WorkspaceProviderSetting />
    </MemoryRouter>,
  );

describe('WorkspaceProviderSetting', () => {
  it('provides settings context for the reused provider settings page', () => {
    managePermission.allowed = true;
    renderPage('openai');

    expect(screen.getByTestId('provider-context')).toHaveTextContent('true:true');
  });

  // The provider roadmap footer was removed from the provider list page in
  // #17217, so the page renders no footer for any provider anymore.
  it('renders no provider footer', () => {
    managePermission.allowed = true;
    renderPage('openai');

    expect(screen.queryByTestId('provider-footer')).not.toBeInTheDocument();
  });

  it('renders forbidden screen without manage_settings permission', () => {
    managePermission.allowed = false;
    renderPage('openai');

    expect(screen.queryByTestId('provider-context')).toBeNull();
    expect(screen.getByText('403')).toBeInTheDocument();
  });

  // The `provider_settings` flag gate lives in the reused list page (merged
  // upstream dropped the lazy require), so verify the route-level redirect too.
  it('redirects to /settings when the provider_settings flag is off', () => {
    managePermission.allowed = true;
    providerFlag.showProvider = false;

    const LocationProbe = () => {
      const location = useLocation();
      return <div data-testid="location-pathname">{location.pathname}</div>;
    };

    render(
      <MemoryRouter initialEntries={['/?provider=openai']}>
        <WorkspaceProviderSetting />
        <LocationProbe />
      </MemoryRouter>,
    );

    expect(screen.queryByTestId('provider-context')).toBeNull();
    expect(screen.getByTestId('location-pathname')).toHaveTextContent('/settings');
  });
});

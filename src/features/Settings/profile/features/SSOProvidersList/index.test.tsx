import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import SSOProvidersList from './index';

const mocks = vi.hoisted(() => ({
  details: {} as Record<string, { displayName: string; logoUrl: string | null }>,
  providers: [] as Array<{ email?: string; provider: string; providerAccountId: string }>,
}));

vi.mock('@lobechat/const', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  isDesktop: false,
}));
vi.mock('@lobehub/ui', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@/store/serverConfig', () => ({
  useServerConfigStore: (selector: (state: unknown) => unknown) =>
    selector({ serverConfig: { oAuthSSOProviders: [] } }),
}));
vi.mock('@/store/user', () => ({
  useUserStore: (selector: (state: unknown) => unknown) =>
    selector({
      authProviders: mocks.providers,
      hasPasswordAccount: true,
      isSignedIn: true,
      refreshAuthProviders: vi.fn(),
    }),
}));
vi.mock('./useSsoProviderDetails', () => ({
  useSsoProviderDetails: () => mocks.details,
}));

describe('SSOProvidersList', () => {
  beforeEach(() => {
    mocks.details = {};
    mocks.providers = [{ email: 'cpc@x.com', provider: 'clerk', providerAccountId: 'user_1' }];
  });

  it("shows a linked account with the provider's configured name and logo", () => {
    mocks.details = { clerk: { displayName: 'Clerk SSO', logoUrl: 'https://img.clerk.com/a.png' } };

    const { container } = render(<SSOProvidersList />);

    expect(screen.getByText('Clerk SSO')).toBeTruthy();
    expect(screen.queryByText('clerk')).toBeNull();
    expect([...container.querySelectorAll('img')].map((img) => img.getAttribute('src'))).toEqual([
      'https://img.clerk.com/a.png',
    ]);
  });

  it('falls back to the provider id and the generic icon without metadata', () => {
    const { container } = render(<SSOProvidersList />);

    expect(screen.getByText('clerk')).toBeTruthy();
    expect(container.querySelectorAll('img')).toHaveLength(0);
    expect(container.querySelectorAll('svg').length).toBeGreaterThan(0);
  });

  it('falls back to the icon when the logo cannot be loaded', () => {
    mocks.details = { clerk: { displayName: 'Clerk SSO', logoUrl: 'https://img.clerk.com/a.png' } };
    const { container } = render(<SSOProvidersList />);

    fireEvent.error(container.querySelector('img')!);

    expect(container.querySelectorAll('img')).toHaveLength(0);
    expect(screen.getByText('Clerk SSO')).toBeTruthy();
  });
});

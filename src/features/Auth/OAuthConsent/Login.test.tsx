import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import Login from './Login';

const mocks = vi.hoisted(() => ({
  redirectToSignIn: vi.fn(),
  refetch: vi.fn(),
  session: {
    data: null as unknown,
    error: null as unknown,
    isPending: false,
    refetch: undefined as unknown as VoidFunction,
  },
}));

vi.mock('@/libs/better-auth/auth-client', () => ({ useSession: () => mocks.session }));
vi.mock('./signInRedirect', () => ({ redirectToSignIn: mocks.redirectToSignIn }));
// The session state (account block / error) renders inside the card body.
vi.mock('@/features/AuthCard', () => ({
  default: ({ children, footer }: any) => (
    <div>
      {children}
      {footer}
    </div>
  ),
}));
vi.mock('./OAuthApplicationLogo', () => ({ default: () => null }));

const renderLogin = () =>
  render(
    <MemoryRouter>
      <Login clientMetadata={{ clientName: 'LobeHub Desktop' } as any} uid="uid-1" />
    </MemoryRouter>,
  );

describe('OAuth login confirmation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.session = { data: null, error: null, isPending: false, refetch: mocks.refetch };
  });

  it('sends a visitor without a session to sign in instead of a dead-end button', () => {
    mocks.session = { data: null, error: null, isPending: false, refetch: mocks.refetch };

    renderLogin();

    expect(mocks.redirectToSignIn).toHaveBeenCalledTimes(1);
  });

  it('waits while the session is still loading', () => {
    mocks.session = { data: null, error: null, isPending: true, refetch: mocks.refetch };

    renderLogin();

    expect(mocks.redirectToSignIn).not.toHaveBeenCalled();
  });

  it('stays on the page with a retryable error when the session lookup fails', () => {
    mocks.session = {
      data: null,
      error: new Error('network'),
      isPending: false,
      refetch: mocks.refetch,
    };

    renderLogin();

    expect(mocks.redirectToSignIn).not.toHaveBeenCalled();
    expect(screen.getByText('login.error.message')).toBeTruthy();
  });

  it('retries the session lookup from the error message', () => {
    mocks.session = {
      data: null,
      error: new Error('network'),
      isPending: false,
      refetch: mocks.refetch,
    };

    renderLogin();

    fireEvent.click(screen.getByRole('button', { name: 'common:retry' }));

    expect(mocks.refetch).toHaveBeenCalledTimes(1);
    expect(mocks.redirectToSignIn).not.toHaveBeenCalled();
  });

  it('lets a signed-in user confirm', () => {
    mocks.session = {
      data: { user: { name: 'Owner' } },
      error: null,
      isPending: false,
      refetch: mocks.refetch,
    };

    const { getByTestId } = renderLogin();

    expect(mocks.redirectToSignIn).not.toHaveBeenCalled();
    expect(getByTestId('oauth-consent-accept').hasAttribute('disabled')).toBe(false);
  });
});

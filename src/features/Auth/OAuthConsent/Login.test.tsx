import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import Login from './Login';

const mocks = vi.hoisted(() => ({
  redirectToSignIn: vi.fn(),
  session: { data: null as unknown, isPending: false },
}));

vi.mock('@/libs/better-auth/auth-client', () => ({ useSession: () => mocks.session }));
vi.mock('./signInRedirect', () => ({ redirectToSignIn: mocks.redirectToSignIn }));
vi.mock('@/features/AuthCard', () => ({ default: ({ footer }: any) => <div>{footer}</div> }));
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
  });

  it('sends a visitor without a session to sign in instead of a dead-end button', () => {
    mocks.session = { data: null, isPending: false };

    renderLogin();

    expect(mocks.redirectToSignIn).toHaveBeenCalledTimes(1);
  });

  it('waits while the session is still loading', () => {
    mocks.session = { data: null, isPending: true };

    renderLogin();

    expect(mocks.redirectToSignIn).not.toHaveBeenCalled();
  });

  it('lets a signed-in user confirm', () => {
    mocks.session = { data: { user: { name: 'Owner' } }, isPending: false };

    const { getByTestId } = renderLogin();

    expect(mocks.redirectToSignIn).not.toHaveBeenCalled();
    expect(getByTestId('oauth-consent-accept').hasAttribute('disabled')).toBe(false);
  });
});

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import OAuthConsent from './index';
import { InteractionDetailsError } from './useInteractionDetails';

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  state: {} as { data?: unknown; error?: unknown; isLoading?: boolean },
}));

vi.mock('react-router', () => ({ useParams: () => ({ uid: 'uid-1' }) }));
vi.mock('../OAuthGuard', () => ({ default: ({ children }: any) => children }));
vi.mock('@/components/404', () => ({ default: () => <div>not-found</div> }));
vi.mock('./Consent', () => ({
  default: ({ onRetry }: any) => (
    <button type="button" onClick={onRetry}>
      consent-card
    </button>
  ),
}));
vi.mock('./Login', () => ({ default: () => null }));
vi.mock('./useInteractionDetails', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useInteractionDetails: () => ({ isLoading: false, mutate: mocks.mutate, ...mocks.state }),
}));

describe('OAuth interaction errors', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.state = {};
  });

  it('tells the user the signed-in account changed when the server reports session_changed', () => {
    mocks.state = { error: new InteractionDetailsError(400, 'session_changed') };

    render(<OAuthConsent />);

    expect(screen.getByText('consent.error.sessionChanged.title')).toBeTruthy();
    expect(screen.getByText('consent.error.sessionChanged.message')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'common:retry' })).toBeNull();
  });

  it('keeps other 400 responses as an invalid authorization session', () => {
    mocks.state = { error: new InteractionDetailsError(400, 'session_invalid') };

    render(<OAuthConsent />);

    expect(screen.getByText('consent.error.sessionInvalid.title')).toBeTruthy();
    expect(screen.queryByText('consent.error.sessionChanged.title')).toBeNull();
  });

  it('keeps a 400 without an error code as an invalid authorization session', () => {
    mocks.state = { error: new InteractionDetailsError(400) };

    render(<OAuthConsent />);

    expect(screen.getByText('consent.error.sessionInvalid.title')).toBeTruthy();
  });

  it('offers a retry that refetches when the session cannot be read', () => {
    mocks.state = { error: new InteractionDetailsError(503, 'session_unavailable') };

    render(<OAuthConsent />);

    expect(screen.getByText('consent.error.sessionUnavailable.title')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'common:retry' }));

    expect(mocks.mutate).toHaveBeenCalledTimes(1);
  });

  it('passes a refetch callback to the consent card', () => {
    mocks.state = { data: { clientMetadata: {}, prompt: 'consent', scopes: [], uid: 'uid-1' } };

    render(<OAuthConsent />);

    fireEvent.click(screen.getByRole('button', { name: 'consent-card' }));

    expect(mocks.mutate).toHaveBeenCalledTimes(1);
  });
});

import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import Consent from './index';

// The account block / notice renders inside the card body, the buttons in its footer.
vi.mock('@/features/AuthCard', () => ({
  default: ({ children, footer }: any) => (
    <div>
      {children}
      {footer}
    </div>
  ),
}));
vi.mock('../OAuthApplicationLogo', () => ({ default: () => null }));

const renderConsent = (props: Partial<React.ComponentProps<typeof Consent>> = {}) => {
  const onRetry = vi.fn();

  render(
    <MemoryRouter>
      <Consent
        clientId="third-party"
        clientMetadata={{ clientName: 'Some App', isFirstParty: true } as any}
        scopes={['openid']}
        uid="uid-1"
        onRetry={onRetry}
        {...props}
      />
    </MemoryRouter>,
  );

  return { onRetry };
};

const isDisabled = (testId: string) =>
  (screen.getByTestId(testId) as HTMLButtonElement).hasAttribute('disabled');

describe('OAuth consent account confirmation', () => {
  it.each([
    ['missing', undefined],
    ['without name or email', { avatar: 'https://example.com/a.png' }],
    ['blank', { email: ' ', name: '' }],
  ])('blocks authorizing when the account is %s, but still allows denying', (_, account) => {
    const { onRetry } = renderConsent({ account });

    expect(isDisabled('oauth-consent-accept')).toBe(true);
    expect(isDisabled('oauth-consent-deny')).toBe(false);
    expect(screen.getByText('consent.account.unavailable')).toBeTruthy();
    expect(screen.queryByText('consent.account.label')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'common:retry' }));

    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('shows the account and allows authorizing when it is identifiable', () => {
    renderConsent({ account: { email: 'owner@example.com', name: 'Owner' } });

    expect(isDisabled('oauth-consent-accept')).toBe(false);
    expect(screen.getByText('Owner')).toBeTruthy();
    expect(screen.queryByText('consent.account.unavailable')).toBeNull();
  });

  it('allows authorizing with only an email', () => {
    renderConsent({ account: { email: 'owner@example.com' } });

    expect(isDisabled('oauth-consent-accept')).toBe(false);
    expect(screen.getByText('owner@example.com')).toBeTruthy();
  });
});

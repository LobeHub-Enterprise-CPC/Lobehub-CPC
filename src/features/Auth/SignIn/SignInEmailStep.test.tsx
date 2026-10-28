import { initializeTenant } from '@lobechat/business-tenant/client';
import { useForm } from '@lobehub/ui/form';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SignInEmailStep, type SignInEmailStepProps } from './SignInEmailStep';

vi.mock('@/features/AuthCard', () => ({
  default: ({ children }: { children: React.ReactNode }) => <section>{children}</section>,
}));
vi.mock('@/features/AuthShell/AuthAgreement', () => ({ default: () => null }));

const EmailStep = (
  props: Pick<
    SignInEmailStepProps,
    | 'desktopAuth'
    | 'disableEmailPassword'
    | 'enableMagicLink'
    | 'oAuthSSOProviders'
    | 'providerDetails'
    | 'tenantUnavailable'
  > & { isSocialOnly?: boolean },
) => {
  const form = useForm({ initialValues: { email: '' } });
  return (
    <SignInEmailStep
      agreementChecked
      serverConfigInit
      continueWithAgreement={(action) => action()}
      form={form}
      isSocialOnly={false}
      loading={false}
      setAgreementChecked={vi.fn()}
      socialLoading={null}
      onGoToSignup={vi.fn()}
      onResetEmail={vi.fn()}
      onSetPassword={vi.fn()}
      onSocialSignIn={vi.fn()}
      {...props}
    />
  );
};

describe('email login availability', () => {
  it.each([
    [true, true, false],
    [true, true, true],
    [true, false, false],
    [true, false, true],
    [false, true, false],
    [false, true, true],
    [false, false, false],
    [false, false, true],
  ])('password=%s magic=%s SSO=%s exposes only available entry points', (password, magic, sso) => {
    render(
      <EmailStep
        disableEmailPassword={!password}
        enableMagicLink={magic}
        oAuthSSOProviders={sso ? ['google'] : []}
      />,
    );
    expect(Boolean(screen.queryByPlaceholderText('betterAuth.signin.emailPlaceholder'))).toBe(
      password || magic,
    );
    expect(Boolean(screen.queryByRole('button', { name: 'betterAuth.signin.signupLink' }))).toBe(
      password,
    );
    expect(Boolean(screen.queryByRole('button', { name: /Continue with Google/ }))).toBe(sso);
    expect(Boolean(screen.queryByText('betterAuth.signin.ssoOnlyNoProviders'))).toBe(
      !password && !magic && !sso,
    );
  });

  it('does not offer setting a password for a social-only account when password login is disabled', () => {
    render(
      <EmailStep
        disableEmailPassword
        isSocialOnly
        enableMagicLink={false}
        oAuthSSOProviders={['google']}
      />,
    );
    expect(screen.queryByRole('button', { name: 'betterAuth.signin.setPassword' })).toBeNull();
    expect(
      screen.getByRole('button', { name: 'betterAuth.signin.emailSent.changeEmail' }),
    ).toBeTruthy();
  });
});

describe('tenant SSO provider buttons', () => {
  const clerk = {
    displayName: 'Clerk SSO',
    id: 'clerk',
    logoUrl: 'https://img.clerk.com/logo.png',
    protocol: 'oidc' as const,
  };
  const noLogo = { ...clerk, logoUrl: null };
  const logos = (container: HTMLElement) => [...container.querySelectorAll('img')];

  it("shows the logo the administrator configured instead of the provider's built-in icon", () => {
    const { container } = render(
      <EmailStep oAuthSSOProviders={['clerk']} providerDetails={{ clerk }} />,
    );

    expect(logos(container).map((img) => img.getAttribute('src'))).toEqual([clerk.logoUrl]);
    // A custom logo replaces the built-in glyph, it does not sit next to it.
    expect(container.querySelectorAll('button svg').length).toBe(0);
  });

  it('names the button after the configured display name', () => {
    render(<EmailStep oAuthSSOProviders={['clerk']} providerDetails={{ clerk }} />);

    expect(
      screen.getByRole('button', { name: /betterAuth\.signin\.continueWithProvider/ }),
    ).toBeTruthy();
  });

  it('keeps the built-in icon of a known provider that has no custom logo', () => {
    const { container } = render(
      <EmailStep
        oAuthSSOProviders={['github']}
        providerDetails={{ github: { ...noLogo, id: 'github' } }}
      />,
    );

    expect(logos(container)).toHaveLength(0);
    expect(container.querySelectorAll('button svg').length).toBeGreaterThan(0);
  });

  it('falls back to the icon when the logo fails to load', () => {
    const { container } = render(
      <EmailStep oAuthSSOProviders={['clerk']} providerDetails={{ clerk }} />,
    );

    fireEvent.error(logos(container)[0]);

    expect(logos(container)).toHaveLength(0);
    expect(container.querySelectorAll('button svg').length).toBeGreaterThan(0);
  });

  it('tries a changed logo URL again after an earlier one failed', () => {
    const { container, rerender } = render(
      <EmailStep oAuthSSOProviders={['clerk']} providerDetails={{ clerk }} />,
    );
    fireEvent.error(logos(container)[0]);

    rerender(
      <EmailStep
        oAuthSSOProviders={['clerk']}
        providerDetails={{ clerk: { ...clerk, logoUrl: 'https://img.clerk.com/new.png' } }}
      />,
    );

    expect(logos(container).map((img) => img.getAttribute('src'))).toEqual([
      'https://img.clerk.com/new.png',
    ]);
  });
});

describe('switch organization entry', () => {
  afterEach(() => {
    initializeTenant(new URL('https://app.example.com/'));
  });

  it('offers the way out from the unavailable organization alert, even without an appUrl', () => {
    initializeTenant(new URL('https://app.example.com/orgs/acme/signin'));

    render(<EmailStep tenantUnavailable oAuthSSOProviders={[]} />);

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('tenant.unavailable.title');
    expect(alert.textContent).toContain('organization.switch.link');
  });
});

describe('switch organization in a desktop authorization', () => {
  afterEach(() => {
    initializeTenant(new URL('https://app.example.com/'));
    Object.defineProperty(window, '__SERVER_CONFIG__', {
      configurable: true,
      value: undefined,
      writable: true,
    });
  });

  const arrive = () => {
    initializeTenant(new URL('https://app.example.com/orgs/acme/signin'));
    Object.defineProperty(window, '__SERVER_CONFIG__', {
      configurable: true,
      value: { appUrl: 'https://app.example.com' },
      writable: true,
    });
  };

  it('does the same inside the unavailable organization alert', () => {
    arrive();

    render(<EmailStep desktopAuth tenantUnavailable oAuthSSOProviders={[]} />);

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('organization.desktop.switchHint');
    expect(alert.textContent).not.toContain('organization.switch.link');
  });
});

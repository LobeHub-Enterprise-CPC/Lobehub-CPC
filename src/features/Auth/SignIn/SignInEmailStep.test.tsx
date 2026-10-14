import { useForm } from '@lobehub/ui/base-ui/form';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { SignInEmailStep, type SignInEmailStepProps } from './SignInEmailStep';

vi.mock('@/features/AuthCard', () => ({
  default: ({ children }: { children: React.ReactNode }) => <section>{children}</section>,
}));
vi.mock('@/features/AuthShell/AuthAgreement', () => ({ default: () => null }));

const EmailStep = (
  props: Pick<
    SignInEmailStepProps,
    'disableEmailPassword' | 'enableMagicLink' | 'oAuthSSOProviders'
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

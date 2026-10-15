import { toast } from '@lobehub/ui/base-ui';
import { useForm } from '@lobehub/ui/base-ui/form';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router';

import type { CheckUserResponseData } from '@/app/(backend)/api/auth/check-user/route';
import type { ResolveUsernameResponseData } from '@/app/(backend)/api/auth/resolve-username/route';
import { useBusinessSignin } from '@/business/client/hooks/useBusinessSignin';
import { useDesktopAuthContext } from '@/features/Auth/desktopAuth';
import {
  isTenantUnavailableCode,
  isTenantUnavailableResponse,
} from '@/features/Auth/utils/tenantUnavailable';
import { useAuthAgreement } from '@/features/AuthShell/AuthAgreement';
import { useAuthServerConfigStore } from '@/features/AuthShell/AuthServerConfigProvider';
import { trackLoginOrSignupClicked } from '@/features/User/UserLoginOrSignup/trackLoginOrSignupClicked';
import { requestPasswordReset, signIn } from '@/libs/better-auth/auth-client';
import { beginBridgeLogin } from '@/libs/better-auth/bridge';
import { isBuiltinProvider, normalizeProviderId } from '@/libs/better-auth/utils/client';
import {
  buildOnboardingRedirectUrl,
  sanitizeRedirectPath,
  toAbsoluteAuthCallbackUrl,
} from '@/utils/onboardingRedirect';

import { EMAIL_REGEX, USERNAME_REGEX } from './SignInEmailStep';

const LAST_AUTH_PROVIDER_KEY = 'lobehub:auth:last-provider:v1';

type Step = 'email' | 'password' | 'emailSent';

type SentEmailType = 'magicLink' | 'resetPassword';

interface SentEmailInfo {
  email: string;
  type: SentEmailType;
}

interface SignInFormValues {
  email: string;
  password: string;
}

interface ResolvedEmailResult {
  email: string;
  identifierType: 'email' | 'username';
}

export const useSignIn = () => {
  const { t } = useTranslation('auth');
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const sessionExpired = searchParams.get('reason') === 'sessionExpired';
  const desktopAuth = useDesktopAuthContext(searchParams.get('callbackUrl'));
  const enableMagicLink = useAuthServerConfigStore((s) => s.serverConfig.enableMagicLink || false);
  const disableEmailPassword = useAuthServerConfigStore(
    (s) => s.serverConfig.disableEmailPassword || false,
  );
  const enableBusinessFeatures = useAuthServerConfigStore(
    (s) => s.serverConfig.enableBusinessFeatures || false,
  );
  const { agreementChecked, continueWithAgreement, setAgreementChecked } = useAuthAgreement();
  const form = useForm<SignInFormValues>({
    initialValues: { email: '', password: '' },
    onSubmit: (values) => {
      if (step === 'password' && !disableEmailPassword) {
        void handleSignIn(values);
        return;
      }
      continueWithAgreement(() => {
        void handleCheckUser(values);
      });
    },
  });
  const [loading, setLoading] = useState(false);
  // Locks the email-dispatch actions (magic link / password reset / resend) so a
  // slow network can't be double-clicked into multiple emails.
  const [sending, setSending] = useState(false);
  const [socialLoading, setSocialLoading] = useState<string | null>(null);
  // Set after mount so the stored terms acceptance (read in an effect) has settled with it.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const continueButtonRef = useRef<HTMLButtonElement | HTMLAnchorElement>(null);
  const prefillHandled = useRef(false);
  const bridgeAttempt = useRef<ReturnType<typeof beginBridgeLogin> | null>(null);
  useEffect(() => () => bridgeAttempt.current?.cancel(), []);
  const [step, setStep] = useState<Step>('email');
  const [email, setEmail] = useState('');
  const [sentInfo, setSentInfo] = useState<SentEmailInfo | null>(null);
  const [isSocialOnly, setIsSocialOnly] = useState(false);
  // Read after mount, not during render: this page is prerendered, and a stored
  // provider would make the first client render disagree with the document.
  const [lastAuthProvider, setLastAuthProvider] = useState<string | null>(null);
  const serverConfigInit = useAuthServerConfigStore((s) => s.serverConfigInit);
  const oAuthSSOProviders = useAuthServerConfigStore((s) => s.serverConfig.oAuthSSOProviders) || [];
  const {
    getAdditionalData,
    managedSSO,
    preSocialSigninCheck,
    reloadSSO,
    ssoError,
    ssoLoaded,
    ssoProviders,
    tenantUnavailable,
  } = useBusinessSignin();

  useEffect(() => {
    try {
      setLastAuthProvider(localStorage.getItem(LAST_AUTH_PROVIDER_KEY));
    } catch {
      // Private mode and blocked storage both just mean "no last provider".
    }
  }, []);

  useEffect(() => {
    const emailParam = searchParams.get('email');
    if (emailParam) form.setValue('email', emailParam);
  }, [searchParams, form]);

  const handleSendMagicLink = async (targetEmail?: string): Promise<boolean> => {
    if (!enableMagicLink || sending) return false;
    try {
      const emailValue =
        targetEmail ||
        (await form
          .validate(['email'])
          .then(({ valid }) => (valid ? form.getValue('email') : null)));
      if (!emailValue) return false;

      setSending(true);
      const callbackUrl = searchParams.get('callbackUrl') || '/';
      const authOrigin = window.location.origin;
      const { error } = await signIn.magicLink({
        callbackURL: toAbsoluteAuthCallbackUrl(callbackUrl, authOrigin),
        email: emailValue,
        // First-time magic-link users are signups — land them on onboarding first
        newUserCallbackURL: toAbsoluteAuthCallbackUrl(
          buildOnboardingRedirectUrl(callbackUrl),
          authOrigin,
        ),
      });
      if (error) {
        toast.error(error.message || t('betterAuth.signin.magicLinkError'));
        return false;
      }
      // Success is a forward step, not a fleeting toast: land on a persistent
      // "check your inbox" screen (ux Act §3.5).
      setSentInfo({ email: emailValue, type: 'magicLink' });
      setStep('emailSent');
      return true;
    } catch (error) {
      console.error('Magic link error:', error);
      toast.error(t('betterAuth.signin.magicLinkError'));
      return false;
    } finally {
      setSending(false);
    }
  };

  const resolveEmailFromIdentifier = async (
    identifier: string,
  ): Promise<ResolvedEmailResult | null> => {
    const trimmedIdentifier = identifier.trim();
    if (!trimmedIdentifier) return null;

    const isEmailIdentifier = EMAIL_REGEX.test(trimmedIdentifier);
    if (isEmailIdentifier)
      return { email: trimmedIdentifier.toLowerCase(), identifierType: 'email' };

    if (!USERNAME_REGEX.test(trimmedIdentifier)) {
      toast.error(t('betterAuth.errors.emailInvalid'));
      return null;
    }

    try {
      const response = await fetch('/api/auth/resolve-username', {
        body: JSON.stringify({ username: trimmedIdentifier }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      });
      const data: ResolveUsernameResponseData = await response.json();
      if (!response.ok || !data.exists || !data.email) {
        toast.error(t('betterAuth.errors.usernameNotRegistered'));
        return null;
      }
      return { email: data.email, identifierType: 'username' };
    } catch (error) {
      console.error('Error resolving username:', error);
      toast.error(t('betterAuth.signin.error'));
      return null;
    }
  };

  const checkUser = async (values: Pick<SignInFormValues, 'email'>) => {
    if (disableEmailPassword && !enableMagicLink) return;
    setLoading(true);
    await trackLoginOrSignupClicked({ spm: 'signin.email_step.submit' });

    try {
      const resolvedEmail = await resolveEmailFromIdentifier(values.email);
      if (!resolvedEmail) return;

      const { email: targetEmail, identifierType } = resolvedEmail;
      const response = await fetch('/api/auth/check-user', {
        body: JSON.stringify({ email: targetEmail }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      });
      if (await isTenantUnavailableResponse(response)) {
        toast.error(t('tenant.unavailable.description'));
        return;
      }
      if (!response.ok) {
        toast.error(t('betterAuth.signin.error'));
        return;
      }
      const data: CheckUserResponseData = await response.json();

      if (!data.exists) {
        if (identifierType === 'username') {
          toast.error(t('betterAuth.errors.usernameNotRegistered'));
          return;
        }
        if (disableEmailPassword) {
          await handleSendMagicLink(targetEmail);
          return;
        }
        const callbackUrl = searchParams.get('callbackUrl') || '/';
        const signupParams = new URLSearchParams();
        signupParams.set('email', targetEmail);
        signupParams.set('callbackUrl', callbackUrl);
        const utmSource = searchParams.get('utm_source');
        if (utmSource) signupParams.set('utm_source', utmSource);
        const referral = searchParams.get('referral');
        if (referral) signupParams.set('referral', referral);
        navigate(`/signup?${signupParams.toString()}`);
        return;
      }

      setEmail(targetEmail);
      if (data.hasPassword && !disableEmailPassword) {
        setStep('password');
        return;
      }

      if (enableMagicLink) {
        await handleSendMagicLink(targetEmail);
        return;
      }

      // User has no password and magic link is disabled, they can only sign in via social
      setIsSocialOnly(true);
    } catch (error) {
      console.error('Error checking user:', error);
      toast.error(t('betterAuth.signin.error'));
    } finally {
      setLoading(false);
    }
  };

  // Every submission goes through here, and the first one retires the prefill's own
  // auto-continue: whatever the user submitted is what they meant, not the URL's email.
  const handleCheckUser = (values: Pick<SignInFormValues, 'email'>) => {
    prefillHandled.current = true;
    return checkUser(values);
  };

  const handleSignIn = async (values: Pick<SignInFormValues, 'password'>) => {
    if (disableEmailPassword) return;
    setLoading(true);
    await trackLoginOrSignupClicked({ spm: 'signin.password_step.submit' });

    try {
      const callbackUrl = sanitizeRedirectPath(searchParams.get('callbackUrl') || '/');
      const result = await signIn.email(
        {
          callbackURL: toAbsoluteAuthCallbackUrl(callbackUrl, window.location.origin),
          email,
          password: values.password,
        },
        {
          onError: (ctx) => {
            console.error('Sign in error:', ctx.error);
            if (isTenantUnavailableCode(ctx.error.code)) {
              toast.error(t('tenant.unavailable.description'));
              return;
            }
            if (ctx.error.status === 403) {
              navigate(
                `/verify-email?email=${encodeURIComponent(email)}&callbackUrl=${encodeURIComponent(callbackUrl)}`,
              );
            }
          },
        },
      );

      if (
        result.error &&
        result.error.status !== 403 &&
        !isTenantUnavailableCode(result.error.code)
      ) {
        // Wrong password is the most common sign-in failure. Keep the error
        // pinned inline on the field (persistent, with retry context) rather
        // than a toast that vanishes in 3s (ux Read §1.1 / Same-Page Error).
        form.setErrors({ password: result.error.message || t('betterAuth.signin.error') });
      }
    } catch (error) {
      console.error('Sign in error:', error);
      toast.error(t('betterAuth.signin.error'));
    } finally {
      setLoading(false);
    }
  };

  const handleSocialSignIn = async (provider: string) => {
    if (bridgeAttempt.current) return;
    setSocialLoading(provider);
    if (ssoProviders.find((item) => item.id === provider)?.protocol === 'bridge') {
      try {
        // Open in the trusted click, before telemetry or any other async work.
        const attempt = beginBridgeLogin(
          provider,
          sanitizeRedirectPath(searchParams.get('callbackUrl') || '/'),
        );
        bridgeAttempt.current = attempt;
        const result = await attempt.completion;
        window.location.assign(sanitizeRedirectPath(result.callbackURL || '/'));
      } catch (error) {
        const code = error instanceof Error ? error.message : '';
        toast.error(
          t(
            code === 'BRIDGE_POPUP_BLOCKED'
              ? 'bridge.popupBlocked'
              : code === 'BRIDGE_EXPIRED'
                ? 'bridge.expired'
                : code === 'BRIDGE_CANCELLED'
                  ? 'bridge.cancelled'
                  : 'bridge.failed',
          ),
        );
      } finally {
        bridgeAttempt.current = null;
        setSocialLoading(null);
      }
      return;
    }
    const normalizedProvider = normalizeProviderId(provider);
    await trackLoginOrSignupClicked({
      provider: normalizedProvider,
      spm: 'signin.social.click',
    });

    try {
      if (enableBusinessFeatures && !(await preSocialSigninCheck())) {
        setSocialLoading(null);
        return;
      }

      try {
        localStorage.setItem(LAST_AUTH_PROVIDER_KEY, provider);
      } catch {
        // Ignore localStorage errors (e.g., quota exceeded, private mode)
      }

      const callbackUrl = searchParams.get('callbackUrl') || '/';
      // First-time OAuth users are signups — land them on onboarding first
      const authOrigin = window.location.origin;
      const callbackURL = toAbsoluteAuthCallbackUrl(callbackUrl, authOrigin);
      const newUserCallbackURL = toAbsoluteAuthCallbackUrl(
        buildOnboardingRedirectUrl(callbackUrl),
        authOrigin,
      );
      const additionalData = await getAdditionalData();
      const managedProvider = managedSSO
        ? ssoProviders.find((item) => item.id === provider)
        : undefined;
      if (managedSSO && !managedProvider) throw new Error('SSO provider unavailable');
      const signInWithAdditionalData = async () =>
        managedProvider?.protocol === 'oidc'
          ? await signIn.sso({
              callbackURL,
              newUserCallbackURL,
              providerId: managedProvider.id,
            })
          : managedProvider
            ? await signIn.oauth2({
                callbackURL,
                newUserCallbackURL,
                providerId: managedProvider.id,
              })
            : isBuiltinProvider(normalizedProvider)
              ? await signIn.social({
                  additionalData,
                  callbackURL,
                  newUserCallbackURL,
                  provider: normalizedProvider,
                })
              : await signIn.oauth2({
                  additionalData,
                  callbackURL,
                  newUserCallbackURL,
                  providerId: normalizedProvider,
                });

      const result = await signInWithAdditionalData();

      if (result && 'error' in result && result.error) throw result.error;
    } catch (error) {
      console.error(`${normalizedProvider} sign in error:`, error);
      toast.error(t('betterAuth.signin.socialError'));
    } finally {
      setSocialLoading(null);
    }
  };

  const handleBackToEmail = () => {
    setStep('email');
    setEmail('');
    setIsSocialOnly(false);
    // Drop the previous account's password + any inline error. The form
    // instance is shared across steps and defaults to preserve, so without this
    // the next email's password step remounts pre-filled with the stale value.
    form.reset({ ...form.getValues(), password: '' });
  };

  const handleGoToSignup = () => {
    if (disableEmailPassword) return;
    const currentEmail = form.getValue('email');
    const callbackUrl = searchParams.get('callbackUrl') || '/';
    const params = new URLSearchParams();
    if (currentEmail) params.set('email', currentEmail);
    params.set('callbackUrl', callbackUrl);
    const utmSource = searchParams.get('utm_source');
    if (utmSource) params.set('utm_source', utmSource);
    const referral = searchParams.get('referral');
    if (referral) params.set('referral', referral);
    void trackLoginOrSignupClicked({ spm: 'signin.go_to_signup.click' }).finally(() => {
      navigate(`/signup?${params.toString()}`);
    });
  };

  // Fire the password-reset email. Returns true on success. Shared by the
  // "forgot password" entry and the resend action on the sent screen.
  const dispatchPasswordReset = async (targetEmail: string): Promise<boolean> => {
    if (disableEmailPassword || sending) return false;
    setSending(true);
    try {
      // The better-auth client resolves with `{ data, error }` instead of
      // throwing, so a failed send would otherwise land on the "email sent" screen.
      const { error } = await requestPasswordReset({
        email: targetEmail,
        redirectTo: toAbsoluteAuthCallbackUrl(
          `/reset-password?email=${encodeURIComponent(targetEmail)}`,
          window.location.origin,
        ),
      });
      if (error) throw error;
      return true;
    } catch {
      toast.error(t('betterAuth.signin.forgotPasswordError'));
      return false;
    } finally {
      setSending(false);
    }
  };

  const handleForgotPassword = async () => {
    if (disableEmailPassword || !email || sending) return;
    const ok = await dispatchPasswordReset(email);
    if (!ok) return;
    setSentInfo({ email, type: 'resetPassword' });
    setStep('emailSent');
  };

  const handleResendEmail = async () => {
    if (!sentInfo || sending) return;
    const ok =
      sentInfo.type === 'magicLink'
        ? await handleSendMagicLink(sentInfo.email)
        : await dispatchPasswordReset(sentInfo.email);
    if (ok) toast.success(t('betterAuth.signin.emailSent.resent'));
  };

  // "Use a different email" — always drop back to the email entry so the label
  // matches the action (returning to the password step would keep the same email).
  const handleBackFromSent = () => {
    setSentInfo(null);
    handleBackToEmail();
  };

  const resolvedProviders = !ssoLoaded
    ? []
    : managedSSO
      ? ssoProviders.map((item) => item.id)
      : [
          ...new Set([
            ...oAuthSSOProviders,
            ...ssoProviders.filter((item) => item.protocol === 'bridge').map((item) => item.id),
          ]),
        ];
  const sortedProviders = lastAuthProvider
    ? [...resolvedProviders].sort((a, b) => {
        if (a === lastAuthProvider) return -1;
        if (b === lastAuthProvider) return 1;
        return 0;
      })
    : resolvedProviders;

  // A prefilled email (arriving from the organization lookup) carries on by itself, once.
  // Where SSO is offered the user still has a choice to make, so it only hands them the
  // button; where the terms were not accepted on this origin the click has to be theirs.
  const emailParam = searchParams.get('email')?.trim() ?? '';
  const emailSignInEnabled = !disableEmailPassword || enableMagicLink;
  const prefillSettled = mounted && ssoLoaded && !ssoError && !tenantUnavailable;
  const checkUserRef = useRef(checkUser);
  checkUserRef.current = checkUser;

  useEffect(() => {
    if (prefillHandled.current || !prefillSettled || !emailSignInEnabled) return;
    if (step !== 'email' || !EMAIL_REGEX.test(emailParam)) return;
    prefillHandled.current = true;

    // The field is editable while the SSO configuration loads. Carry on only with what it
    // still holds: an edited address is the user's, and is theirs to submit.
    if (String(form.getValue('email') ?? '').trim() !== emailParam) return;

    if (resolvedProviders.length > 0 || !agreementChecked) {
      continueButtonRef.current?.focus();
      return;
    }
    void checkUserRef.current({ email: emailParam });
  }, [
    agreementChecked,
    emailParam,
    emailSignInEnabled,
    form,
    prefillSettled,
    resolvedProviders.length,
    step,
  ]);

  return {
    agreementChecked,
    continueButtonRef,
    continueWithAgreement,
    desktopAuth,
    disableEmailPassword,
    email,
    enableMagicLink,
    form,
    handleBackFromSent,
    handleBackToEmail,
    handleCheckUser,
    handleForgotPassword,
    handleGoToSignup,
    handleResendEmail,
    handleSignIn,
    handleSocialSignIn,
    isSocialOnly,
    lastAuthProvider,
    loading,
    oAuthSSOProviders: sortedProviders,
    providerDetails: Object.fromEntries(ssoProviders.map((item) => [item.id, item])),
    reloadSSO,
    sending,
    sessionExpired,
    sentInfo,
    serverConfigInit: ssoLoaded && serverConfigInit,
    setAgreementChecked,
    socialLoading,
    ssoError,
    tenantUnavailable,
    step,
  };
};

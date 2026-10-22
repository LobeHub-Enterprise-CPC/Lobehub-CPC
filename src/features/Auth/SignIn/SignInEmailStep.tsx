import { BRANDING_NAME } from '@lobechat/business-const';
import {
  Alert,
  Badge,
  Button,
  createStaticStyles,
  Divider,
  Flexbox,
  Icon,
  Text,
} from '@lobehub/ui';
import { type FormInstance } from '@lobehub/ui/form';
import { type CSSProperties, type RefObject, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import type { BusinessSSOProvider } from '@/business/client/hooks/useBusinessSignin';
import AuthIcons from '@/components/AuthIcons';
import AuthEmailForm from '@/features/Auth/AuthEmailForm';
import SsoProviderIcon from '@/features/Auth/SsoProviderIcon';
import AuthCard from '@/features/AuthCard';
import AuthAgreement from '@/features/AuthShell/AuthAgreement';
import { SwitchOrganizationLink } from '@/features/TenantDiscovery/SwitchOrganizationLink';

import { CurrentOrganization } from './CurrentOrganization';
import { EMAIL_REGEX, USERNAME_REGEX } from './emailRegex';

const styles = createStaticStyles(({ css, cssVar }) => ({
  inlineLink: css`
    cursor: pointer;
    color: ${cssVar.colorPrimary};
    text-decoration: underline;
  `,
}));

export { EMAIL_REGEX, USERNAME_REGEX };

// Pin both the provider logo and the loading spinner to the same spot so the
// spinner doesn't jump when a social button enters its loading state.
const PROVIDER_ICON_STYLE: CSSProperties = {
  insetInlineStart: 12,
  position: 'absolute',
  top: '50%',
  transform: 'translateY(-50%)',
};

// Turn a provider id into a display name, e.g. "google" -> "Google".
const getProviderName = (provider: string) =>
  provider.toLowerCase().replaceAll(/(^|[_-])([a-z])/g, (_, __, c) => c.toUpperCase());

export interface SignInEmailStepProps {
  agreementChecked: boolean;
  /** Lets the page move focus to the primary button, e.g. after a prefilled email arrives. */
  continueButtonRef?: RefObject<HTMLButtonElement | HTMLAnchorElement | null>;
  continueWithAgreement: (continueAction: () => void) => void;
  /** The sign-in serves the desktop app's authorization: no web "switch organization" link. */
  desktopAuth?: boolean;
  disableEmailPassword?: boolean;
  enableMagicLink?: boolean;
  form: FormInstance<{ email: string }>;
  isSocialOnly: boolean;
  lastAuthProvider?: string | null;
  loading: boolean;
  oAuthSSOProviders: string[];
  onGoToSignup: () => void;
  onResetEmail: () => void;
  onSetPassword: () => void;
  onSocialSignIn: (provider: string) => void;
  providerDetails?: Record<string, BusinessSSOProvider>;
  reloadSSO?: () => void;
  serverConfigInit: boolean;
  sessionExpired?: boolean;
  setAgreementChecked: (checked: boolean) => void;
  socialLoading: string | null;
  ssoError?: boolean;
  /** The workspace is frozen, expired, offline or not provisioned. */
  tenantUnavailable?: boolean;
}

export const SignInEmailStep = ({
  agreementChecked,
  continueButtonRef,
  continueWithAgreement,
  desktopAuth,
  disableEmailPassword,
  enableMagicLink,
  form,
  isSocialOnly,
  lastAuthProvider,
  loading,
  oAuthSSOProviders,
  providerDetails = {},
  reloadSSO,
  serverConfigInit,
  sessionExpired,
  setAgreementChecked,
  socialLoading,
  ssoError,
  tenantUnavailable,
  onGoToSignup,
  onResetEmail,
  onSetPassword,
  onSocialSignIn,
}: SignInEmailStepProps) => {
  const { t } = useTranslation('auth');
  const emailInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    emailInputRef.current?.focus();
  }, []);

  const divider = (
    <Divider style={{ marginBlock: 16 }}>
      <Text fontSize={12} type={'secondary'}>
        {t('betterAuth.signin.orContinueWith')}
      </Text>
    </Divider>
  );

  const getProviderLabel = (provider: string) => {
    if (providerDetails[provider])
      return t('betterAuth.signin.continueWithProvider', {
        provider: providerDetails[provider].displayName,
      });
    const normalized = getProviderName(provider);
    const normalizedKey = normalized.replaceAll(/[^\da-z]/gi, '');
    const key = `betterAuth.signin.continueWith${normalizedKey}`;
    return t(key, { defaultValue: `Continue with ${normalized}` });
  };

  // Config is injected synchronously via window.__SERVER_CONFIG__, so the email
  // form is the primary path unless the account is social-only.
  const emailSignInEnabled = !disableEmailPassword || enableMagicLink;
  const showEmailForm = emailSignInEnabled && !isSocialOnly;

  return (
    <AuthCard title={t('signin.subtitle', { appName: BRANDING_NAME })}>
      {tenantUnavailable ? (
        <Alert
          showIcon
          description={t('tenant.unavailable.description')}
          title={t('tenant.unavailable.title')}
          type="error"
          action={
            <Flexbox horizontal gap={8}>
              <Button onClick={reloadSSO}>{t('betterAuth.signin.ssoRetry')}</Button>
              <SwitchOrganizationLink
                originFallback
                appearance={'button'}
                desktopAuth={desktopAuth}
              />
            </Flexbox>
          }
        />
      ) : ssoError ? (
        <Alert
          showIcon
          action={<Button onClick={reloadSSO}>{t('betterAuth.signin.ssoRetry')}</Button>}
          description={t('betterAuth.signin.ssoLoadError')}
          type="error"
        />
      ) : !serverConfigInit ? (
        <Text role="status">{t('betterAuth.signin.ssoLoading')}</Text>
      ) : null}
      {sessionExpired && (
        <Alert
          showIcon
          message={t('betterAuth.signin.sessionExpired')}
          style={{ marginBlockEnd: 12 }}
          type="warning"
          variant="filled"
        />
      )}
      {serverConfigInit && oAuthSSOProviders.length > 0 && (
        <Flexbox gap={12}>
          {oAuthSSOProviders.map((provider) => {
            const button = (
              <Button
                block
                htmlType="button"
                key={provider}
                loading={socialLoading === provider}
                size="large"
                styles={{ icon: PROVIDER_ICON_STYLE }}
                type="fill"
                icon={
                  <SsoProviderIcon
                    fallback={<Icon icon={AuthIcons(provider, 18)} />}
                    logoUrl={providerDetails[provider]?.logoUrl}
                  />
                }
                onClick={() =>
                  continueWithAgreement(() => {
                    onSocialSignIn(provider);
                  })
                }
              >
                {getProviderLabel(provider)}
              </Button>
            );
            const showLastUsed =
              provider === lastAuthProvider &&
              (oAuthSSOProviders.length > 1 ||
                (oAuthSSOProviders.length === 1 && emailSignInEnabled));
            return showLastUsed ? (
              <Badge
                color="var(--lobe-color-info)"
                count={t('betterAuth.signin.lastUsed')}
                key={provider}
                style={{ display: 'block', width: '100%' }}
              >
                {button}
              </Badge>
            ) : (
              button
            );
          })}
          {showEmailForm && divider}
        </Flexbox>
      )}
      {serverConfigInit &&
        !ssoError &&
        !tenantUnavailable &&
        !emailSignInEnabled &&
        oAuthSSOProviders.length === 0 && (
          <Alert showIcon description={t('betterAuth.signin.ssoOnlyNoProviders')} type="warning" />
        )}
      {showEmailForm && (
        <AuthEmailForm
          agreementChecked={agreementChecked}
          autoComplete="username"
          form={form}
          inputRef={emailInputRef}
          loading={loading}
          placeholder={t('betterAuth.signin.emailPlaceholder')}
          setAgreementChecked={setAgreementChecked}
          submitRef={continueButtonRef}
          submitText={t('betterAuth.signin.nextStep')}
          validate={(value) => {
            if (!value) return t('betterAuth.errors.emailRequired');
            const trimmedValue = value.trim();
            if (EMAIL_REGEX.test(trimmedValue) || USERNAME_REGEX.test(trimmedValue)) return;
            return t('betterAuth.errors.emailInvalid');
          }}
        />
      )}
      {isSocialOnly && !disableEmailPassword && (
        <Alert
          showIcon
          style={{ marginTop: 12 }}
          type="info"
          description={
            <>
              {t('betterAuth.signin.socialOnlyHint')}{' '}
              <a
                className={styles.inlineLink}
                role="button"
                tabIndex={0}
                onClick={onSetPassword}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onSetPassword();
                  }
                }}
              >
                {t('betterAuth.signin.setPassword')}
              </a>
            </>
          }
        />
      )}
      {isSocialOnly && (
        <Text align={'center'} fontSize={13} style={{ marginTop: 12 }} type={'secondary'}>
          <a
            className={styles.inlineLink}
            role="button"
            tabIndex={0}
            onClick={onResetEmail}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onResetEmail();
              }
            }}
          >
            {t('betterAuth.signin.emailSent.changeEmail')}
          </a>
        </Text>
      )}
      {!showEmailForm && <AuthAgreement />}
      {showEmailForm && !disableEmailPassword && (
        <Text align={'center'} fontSize={13} style={{ marginTop: 16 }} type={'secondary'}>
          {t('betterAuth.signin.noAccount')}{' '}
          <a
            className={styles.inlineLink}
            role="button"
            tabIndex={0}
            onClick={onGoToSignup}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onGoToSignup();
              }
            }}
          >
            {t('betterAuth.signin.signupLink')}
          </a>
        </Text>
      )}
      <CurrentOrganization desktopAuth={desktopAuth} hideSwitch={tenantUnavailable} />
    </AuthCard>
  );
};

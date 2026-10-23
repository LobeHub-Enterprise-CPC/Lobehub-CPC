'use client';

import { BRANDING_NAME } from '@lobechat/business-const';
import { Alert } from '@lobehub/ui';
import { memo, useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import AuthEmailForm from '@/features/Auth/AuthEmailForm';
import AuthCard from '@/features/AuthCard';

import { AccountConfirmCard } from './AccountConfirmCard';
import { readAccountMode } from './accountMode';
import { OrganizationPicker } from './OrganizationPicker';
import { useOrganizationDiscovery } from './useOrganizationDiscovery';
import { useRememberedAccount } from './useRememberedAccount';

/**
 * Root-path page for a document that addresses no organization: find the organizations an
 * email belongs to and continue to that organization's sign-in page.
 *
 * It is the first half of signing in, so it speaks with the sign-in page's voice: the same
 * card, title, email field, terms checkbox and button.
 */
const TenantDiscoveryForm = memo(() => {
  const { t } = useTranslation('auth');
  const emailInputRef = useRef<HTMLInputElement>(null);
  const {
    agreementChecked,
    choose,
    blocked,
    desktopFlow,
    closePicker,
    dismissNotice,
    form,
    notice,
    organizations,
    pickerOpen,
    searching,
    selectingId,
    setAgreementChecked,
    unavailableIds,
    validateEmail,
  } = useOrganizationDiscovery();

  useEffect(() => {
    emailInputRef.current?.focus();
  }, []);

  const title = t('signin.subtitle', { appName: BRANDING_NAME });
  if (blocked)
    return (
      <AuthCard title={title}>
        <Alert
          showIcon
          type={blocked === 'expired' ? 'warning' : 'error'}
          description={t(
            blocked === 'expired' ? 'organization.desktop.expired' : 'organization.desktop.invalid',
          )}
        />
      </AuthCard>
    );

  return (
    <AuthCard
      title={title}
      subtitle={t(
        desktopFlow.kind === 'active'
          ? 'organization.desktop.subtitle'
          : 'organization.discovery.subtitle',
      )}
    >
      {desktopFlow.kind === 'active' && desktopFlow.fastPathUnavailable && (
        <Alert
          showIcon
          description={t('organization.desktop.fastPathUnavailable')}
          style={{ marginBlockEnd: 16 }}
          type={'warning'}
        />
      )}
      <AuthEmailForm
        agreementChecked={agreementChecked}
        ariaLabel={t('organization.discovery.emailLabel')}
        autoComplete="email"
        form={form}
        inputRef={emailInputRef}
        loading={searching || selectingId !== null}
        placeholder={t('organization.discovery.emailPlaceholder')}
        setAgreementChecked={setAgreementChecked}
        submitText={t('organization.discovery.submit')}
        validate={validateEmail}
        beforeSubmit={
          notice &&
          !pickerOpen && (
            <Alert
              showIcon
              description={notice.text}
              style={{ marginBlockEnd: 16 }}
              type={'error'}
            />
          )
        }
        onEmailChange={dismissNotice}
      />
      <OrganizationPicker
        afterClose={() => emailInputRef.current?.focus()}
        errorText={pickerOpen ? notice?.text : undefined}
        open={pickerOpen}
        organizations={organizations}
        selectingId={selectingId}
        unavailableIds={unavailableIds}
        onClose={closePicker}
        onSelect={choose}
      />
    </AuthCard>
  );
});

TenantDiscoveryForm.displayName = 'TenantDiscoveryForm';

/**
 * The remembered-account branch of the root page: the account's organizations as a confirm
 * card in the same `AuthCard`. When there is no remembered account the finder form takes
 * over in place, without a reload.
 */
const AccountModeContent = memo(() => {
  const { t } = useTranslation('auth');
  const state = useRememberedAccount();

  if (state.status === 'fallback') return <TenantDiscoveryForm />;

  return (
    <AuthCard
      subtitle={t('organization.account.subtitle')}
      title={t('signin.subtitle', { appName: BRANDING_NAME })}
    >
      <AccountConfirmCard state={state} />
    </AuthCard>
  );
});

AccountModeContent.displayName = 'AccountModeContent';

const TenantDiscovery = memo(() => {
  // Fixed for the life of the page: the request that opened it does not change.
  const accountMode = useMemo(() => readAccountMode(), []);
  if (accountMode) return <AccountModeContent />;
  return <TenantDiscoveryForm />;
});

TenantDiscovery.displayName = 'TenantDiscovery';

export default TenantDiscovery;

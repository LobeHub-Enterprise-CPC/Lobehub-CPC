'use client';

import { BRANDING_NAME } from '@lobechat/business-const';
import { memo, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { Alert } from '@lobehub/ui';
import AuthEmailForm from '@/features/Auth/AuthEmailForm';
import AuthCard from '@/features/AuthCard';

import { OrganizationPicker } from './OrganizationPicker';
import { useOrganizationDiscovery } from './useOrganizationDiscovery';

/**
 * Root-path page for a document that addresses no organization: find the organizations an
 * email belongs to and continue to that organization's sign-in page.
 *
 * It is the first half of signing in, so it speaks with the sign-in page's voice: the same
 * card, title, email field, terms checkbox and button.
 */
const TenantDiscovery = memo(() => {
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

TenantDiscovery.displayName = 'TenantDiscovery';

export default TenantDiscovery;

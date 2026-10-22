'use client';

import { type CloudTenant } from '@lobechat/electron-client-ipc';
import { Alert, Button, Center, Flexbox, cssVar } from '@lobehub/ui';
import { LogInIcon, LogOutIcon } from 'lucide-react';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { AuthNotice } from './AuthProgressPanel';
import LobeMessage from './LobeMessage';
import OrganizationIdentity from './OrganizationIdentity';

interface ReloginRequiredPanelProps {
  cloudTenant?: CloudTenant;
  /** The last sign-in attempt failed; shown without leaving this panel. */
  failure?: { message: string; onDismiss: () => void };
  isConnecting: boolean;
  isSigningOut: boolean;
  onRelogin: () => void;
  onSignOut: () => void;
}

/** The organization entry moved while signed in: remote activity is paused until the user signs in again. */
const ReloginRequiredPanel = memo<ReloginRequiredPanelProps>(
  ({ cloudTenant, failure, isConnecting, isSigningOut, onRelogin, onSignOut }) => {
    const { t } = useTranslation('desktop-onboarding');

    return (
      <Center gap={32} style={{ height: '100%', minHeight: '100%' }}>
        <Flexbox align={'flex-start'} gap={8} justify={'flex-start'} style={{ width: '100%' }}>
          <LobeMessage sentences={[t('screen5.endpointChanged.relogin.title')]} />
          <Alert description={t('screen5.endpointChanged.relogin.description')} type={'warning'} />
          {failure && (
            <AuthNotice
              isBusy={isConnecting}
              message={failure.message}
              onDismiss={failure.onDismiss}
            />
          )}
        </Flexbox>

        {cloudTenant && (
          <OrganizationIdentity
            account={cloudTenant.display.account}
            entryUrl={cloudTenant.entryUrl}
            organizationName={cloudTenant.display.organizationName}
            organizationSlug={cloudTenant.display.organizationSlug}
          />
        )}

        <Flexbox horizontal justify={'space-between'} style={{ marginTop: 32, width: '100%' }}>
          <Button
            disabled={isSigningOut}
            icon={LogOutIcon}
            style={{ color: cssVar.colorTextDescription }}
            type={'text'}
            onClick={onSignOut}
          >
            {isSigningOut ? t('screen5.actions.signingOut') : t('screen5.actions.signOut')}
          </Button>
          <Button disabled={isConnecting} icon={LogInIcon} type={'primary'} onClick={onRelogin}>
            {t('screen5.actions.signInAgain')}
          </Button>
        </Flexbox>
      </Center>
    );
  },
);

ReloginRequiredPanel.displayName = 'ReloginRequiredPanel';

export default ReloginRequiredPanel;

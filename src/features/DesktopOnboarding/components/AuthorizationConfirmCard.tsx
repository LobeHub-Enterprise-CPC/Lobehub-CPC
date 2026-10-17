'use client';

import { type AuthorizationConfirmRequest } from '@lobechat/electron-client-ipc';
import { Flexbox } from '@lobehub/ui';
import { Alert, Button, Text } from '@lobehub/ui/base-ui';
import { cssVar } from 'antd-style';
import { memo, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { type ConfirmationAction } from '../hooks/useAuthorizationConfirmation';
import { canOfferOrganizationSwitch } from '../organization';
import LobeMessage from './LobeMessage';
import OrganizationIdentity from './OrganizationIdentity';

const formatRemaining = (ms: number) => {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return `${minutes}:${String(seconds).padStart(2, '0')}`;
};

/** Milliseconds left, re-evaluated every second until the confirmation expires. */
const useRemainingMs = (expiresAt: number) => {
  const [remaining, setRemaining] = useState(() => expiresAt - Date.now());

  useEffect(() => {
    setRemaining(expiresAt - Date.now());
    const timer = setInterval(() => {
      const next = expiresAt - Date.now();
      setRemaining(next);
      if (next <= 0) clearInterval(timer);
    }, 1000);

    return () => clearInterval(timer);
  }, [expiresAt]);

  return remaining;
};

interface AuthorizationConfirmCardProps {
  /** The action currently waiting on main; every button is locked meanwhile. */
  busy?: ConfirmationAction | null;
  onCancel: () => void;
  onConfirm: () => void;
  onSwitchOrganization: () => void;
  request: AuthorizationConfirmRequest;
}

/**
 * Asks the user to check the organization address and account of a login whose tokens are
 * already verified. Nothing is activated or synced until "Confirm".
 */
const AuthorizationConfirmCard = memo<AuthorizationConfirmCardProps>(
  ({ busy, onCancel, onConfirm, onSwitchOrganization, request }) => {
    const { t } = useTranslation('desktop-onboarding');
    const remainingMs = useRemainingMs(request.expiresAt);
    const isExpired = remainingMs <= 0;
    const isBusy = !!busy;
    const canSwitchOrganization = canOfferOrganizationSwitch(request.hasOtherOrganizations);

    return (
      <Flexbox gap={24} style={{ width: '100%' }}>
        <Flexbox gap={8}>
          <LobeMessage sentences={[t('screen5.confirm.title')]} />
          <Text as={'p'} style={{ margin: 0 }} type={'secondary'}>
            {t('screen5.confirm.description')}
          </Text>
        </Flexbox>

        <OrganizationIdentity
          account={request.account}
          entryUrl={request.entryUrl}
          organizationName={request.name}
          organizationSlug={request.slug}
        />

        {isExpired && <Alert description={t('screen5.confirm.expired')} type={'warning'} />}

        <Flexbox gap={12}>
          <Flexbox
            horizontal
            align={'center'}
            gap={8}
            justify={canSwitchOrganization ? 'space-between' : 'flex-end'}
            wrap={'wrap'}
          >
            {canSwitchOrganization && (
              <Button
                disabled={isBusy || isExpired}
                loading={busy === 'switch'}
                style={{ color: cssVar.colorTextSecondary }}
                type={'text'}
                onClick={onSwitchOrganization}
              >
                {t('screen5.confirm.switchOrganization')}
              </Button>
            )}
            <Flexbox horizontal align={'center'} gap={8}>
              <Button disabled={isBusy} loading={busy === 'cancel'} onClick={onCancel}>
                {t('screen5.actions.cancel')}
              </Button>
              <Button
                disabled={isExpired || (isBusy && busy !== 'confirm')}
                loading={busy === 'confirm'}
                type={'primary'}
                onClick={onConfirm}
              >
                {t('screen5.confirm.confirm')}
              </Button>
            </Flexbox>
          </Flexbox>
          {!isExpired && (
            <Text fontSize={12} style={{ color: cssVar.colorTextDescription }}>
              {t('screen5.confirm.remaining', { time: formatRemaining(remainingMs) })}
            </Text>
          )}
        </Flexbox>
      </Flexbox>
    );
  },
);

AuthorizationConfirmCard.displayName = 'AuthorizationConfirmCard';

export default AuthorizationConfirmCard;

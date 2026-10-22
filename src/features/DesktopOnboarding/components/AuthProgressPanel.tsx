'use client';

import { Alert, Button, cssVar,Flexbox, Text } from '@lobehub/ui';
import { ArrowRightLeftIcon, Cloud, MailSearchIcon, Server } from 'lucide-react';
import { type LucideIcon } from 'lucide-react';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

type Method = 'cloud' | 'selfhost';

interface AuthProgressProps {
  /** Label of the disabled progress button. */
  label: string;
  method: Method;
  onCancel: () => void;
  phaseText: string;
  /** Seconds left in the current phase, when main reported a deadline. */
  remainingSeconds: number | null;
}

/** A sign-in that is waiting on the browser or on main: current phase, countdown and cancel. */
export const AuthProgress = memo<AuthProgressProps>(
  ({ label, method, onCancel, phaseText, remainingSeconds }) => {
    const { t } = useTranslation('desktop-onboarding');
    const icon: LucideIcon = method === 'cloud' ? Cloud : Server;

    return (
      <Flexbox gap={8} style={{ width: '100%' }}>
        <Button block disabled loading icon={icon} size={'large'} type={'primary'}>
          {label}
        </Button>
        <Text style={{ color: cssVar.colorTextDescription }} type={'secondary'}>
          {phaseText}
        </Text>
        <Flexbox horizontal align={'center'} justify={'space-between'}>
          {remainingSeconds === null ? (
            <div />
          ) : (
            <Text style={{ color: cssVar.colorTextDescription }} type={'secondary'}>
              {t('screen5.auth.remaining', { time: remainingSeconds })}
            </Text>
          )}
          <Button size={'small'} type={'text'} onClick={onCancel}>
            {t('screen5.actions.cancel')}
          </Button>
        </Flexbox>
      </Flexbox>
    );
  },
);

AuthProgress.displayName = 'AuthProgress';

interface AuthErrorProps {
  /** Offer the organization-email lookup (the typed address was not an organization). */
  canFindByEmail: boolean;
  isBusy: boolean;
  message: string;
  method: Method;
  onFindByEmail: () => void;
  onRetry: () => void;
  onSwitchOrganization: () => void;
  /** Offer an explicit organization switch (the organization changed during auto recovery). */
  requiresSwitch: boolean;
  /** Retry button copy; "Sign in again" when the previous attempt cannot be resumed. */
  retryLabel: string;
}

/** Failure reason plus the recovery actions that fit its code. */
export const AuthError = memo<AuthErrorProps>(
  ({
    canFindByEmail,
    isBusy,
    message,
    method,
    onFindByEmail,
    onRetry,
    onSwitchOrganization,
    retryLabel,
    requiresSwitch,
  }) => {
    const { t } = useTranslation('desktop-onboarding');
    const isCloud = method === 'cloud';

    return (
      <Flexbox gap={16} style={{ width: '100%' }}>
        <Alert description={message} title={t('authResult.failed.title')} type={'secondary'} />
        <Flexbox gap={8} style={{ width: '100%' }}>
          <Button
            block={isCloud}
            icon={isCloud ? Cloud : Server}
            size={isCloud ? 'large' : undefined}
            type={'primary'}
            onClick={onRetry}
          >
            {retryLabel}
          </Button>
          {canFindByEmail && (
            <Button block={isCloud} disabled={isBusy} icon={MailSearchIcon} onClick={onFindByEmail}>
              {t('screen5.actions.findByOrganizationEmail')}
            </Button>
          )}
          {requiresSwitch && (
            <Button
              block={isCloud}
              disabled={isBusy}
              icon={ArrowRightLeftIcon}
              onClick={onSwitchOrganization}
            >
              {t('screen5.actions.switchOrganization')}
            </Button>
          )}
        </Flexbox>
      </Flexbox>
    );
  },
);

AuthError.displayName = 'AuthError';

interface AuthNoticeProps {
  isBusy: boolean;
  message: string;
  /** Close the notice; the signed-in content underneath is never affected. */
  onDismiss: () => void;
  /** Offer an explicit organization switch when the failure code demands one. */
  onSwitchOrganization?: () => void;
}

/**
 * A switch / reconnect that failed while a committed session is still active. The session is
 * untouched, so this is a dismissible notice above the signed-in content, not a replacement.
 */
export const AuthNotice = memo<AuthNoticeProps>(
  ({ isBusy, message, onDismiss, onSwitchOrganization }) => {
    const { t } = useTranslation(['desktop-onboarding', 'common']);

    return (
      <Alert
        closable={{ 'aria-label': t('close', { ns: 'common' }), 'onClose': onDismiss }}
        title={t('authResult.failed.title', { ns: 'desktop-onboarding' })}
        type={'warning'}
        action={
          onSwitchOrganization && (
            <Button
              disabled={isBusy}
              icon={ArrowRightLeftIcon}
              size={'small'}
              onClick={onSwitchOrganization}
            >
              {t('screen5.actions.switchOrganization', { ns: 'desktop-onboarding' })}
            </Button>
          )
        }
        description={
          <Flexbox gap={4}>
            <span>{message}</span>
            <span>{t('screen5.notice.sessionKept', { ns: 'desktop-onboarding' })}</span>
          </Flexbox>
        }
      />
    );
  },
);

AuthNotice.displayName = 'AuthNotice';

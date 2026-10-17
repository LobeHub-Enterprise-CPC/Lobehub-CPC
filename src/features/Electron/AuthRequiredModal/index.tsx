'use client';

import { type AuthorizationPhase } from '@lobechat/electron-client-ipc';
import { useWatchBroadcast } from '@lobechat/electron-client-ipc';
import { Flexbox, Icon } from '@lobehub/ui';
import type { ImperativeModalProps, ModalInstance } from '@lobehub/ui/base-ui';
import { Alert, Button, createModal, ModalFooter } from '@lobehub/ui/base-ui';
import debug from 'debug';
import { AlertCircle, ArrowRightLeftIcon, LogIn, MailSearchIcon } from 'lucide-react';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  authorizationPhaseI18nKeyMap,
  canFindByOrganizationEmail,
  getAuthorizationErrorI18nKey,
  isSupersededAuthorization,
  requiresExplicitSwitch,
} from '@/features/DesktopOnboarding/authorizationErrors';
import { useElectronStore } from '@/store/electron';
import { type AuthorizationUiErrorCode } from '@/store/electron/initialState';

const log = debug('lobe-client:auth-required-modal');

interface AuthRequiredModalContentProps {
  onActionReady: (api: { signIn: () => Promise<void> }) => void;
  onSigningInChange?: (isSigningIn: boolean) => void;
}

interface Failure {
  code?: AuthorizationUiErrorCode;
}

const AuthRequiredModalContent = memo<AuthRequiredModalContentProps>(
  ({ onActionReady, onSigningInChange }) => {
    const { t } = useTranslation('auth');
    const { t: tOnboarding } = useTranslation('desktop-onboarding');
    const [isSigningIn, setIsSigningIn] = useState(false);
    const [failure, setFailure] = useState<Failure | null>(null);
    const [phase, setPhase] = useState<AuthorizationPhase | null>(null);
    const [restarting, setRestarting] = useState<{ attempt: number; maxAttempts: number } | null>(
      null,
    );

    const [
      dataSyncConfig,
      connectRemoteServer,
      clearRemoteServerSyncError,
      requestPlatformAuthorization,
      switchOrganization,
    ] = useElectronStore((s) => [
      s.dataSyncConfig,
      s.connectRemoteServer,
      s.clearRemoteServerSyncError,
      s.requestPlatformAuthorization,
      s.switchOrganization,
    ]);

    useEffect(() => {
      onSigningInChange?.(isSigningIn);
    }, [isSigningIn, onSigningInChange]);

    const endAttempt = useCallback((next: Failure | null) => {
      setIsSigningIn(false);
      setPhase(null);
      setRestarting(null);
      setFailure(next);
    }, []);

    useWatchBroadcast('authorizationFailed', ({ code }) => {
      // An older flow lost to a newer one: the newer one is still running.
      if (isSupersededAuthorization(code)) return;
      endAttempt({ code });
    });

    useWatchBroadcast('authorizationProgress', (progress) => {
      if (progress.phase === 'cancelled') {
        endAttempt(null);
        return;
      }
      setPhase(progress.phase);
      setRestarting(null);
    });

    useWatchBroadcast('authorizationRestarting', ({ attempt, maxAttempts }) => {
      setRestarting({ attempt, maxAttempts });
    });

    // Starting a flow can fail before main broadcasts anything (e.g. the address pre-check),
    // and a started flow reports nothing until the browser step: read the store afterwards.
    const run = useCallback(
      async (start: () => Promise<void>) => {
        setIsSigningIn(true);
        setFailure(null);
        setPhase(null);
        clearRemoteServerSyncError();

        await start();

        const startFailure = useElectronStore.getState().remoteServerSyncError;
        if (startFailure?.message || startFailure?.code) endAttempt({ code: startFailure.code });
      },
      [clearRemoteServerSyncError, endAttempt],
    );

    const signIn = useCallback(
      () =>
        run(() =>
          connectRemoteServer({
            remoteServerUrl: dataSyncConfig?.remoteServerUrl,
            storageMode: dataSyncConfig?.storageMode || 'cloud',
          }),
        ),
      [connectRemoteServer, dataSyncConfig, run],
    );

    useEffect(() => {
      onActionReady({ signIn });
    }, [onActionReady, signIn]);

    const failureKey = failure
      ? (getAuthorizationErrorI18nKey(failure.code) ?? 'screen5.errors.generic')
      : null;
    const progressKey = restarting ? null : phase ? authorizationPhaseI18nKeyMap[phase] : null;

    return (
      <Flexbox gap={12}>
        <p style={{ margin: 0 }}>{t('authModal.description')}</p>
        {isSigningIn && (restarting || progressKey) && (
          <p style={{ color: 'var(--ant-color-text-description)', margin: 0 }}>
            {restarting
              ? tOnboarding('screen5.auth.phase.restarting', {
                  attempt: restarting.attempt,
                  max: restarting.maxAttempts,
                })
              : progressKey && tOnboarding(progressKey)}
          </p>
        )}
        {failureKey && (
          <Flexbox gap={8}>
            <Alert description={tOnboarding(failureKey)} type={'error'} />
            {canFindByOrganizationEmail(failure?.code) && (
              <Button
                disabled={isSigningIn}
                icon={<Icon icon={MailSearchIcon} />}
                onClick={() => run(() => requestPlatformAuthorization())}
              >
                {tOnboarding('screen5.actions.findByOrganizationEmail')}
              </Button>
            )}
            {/* The server demands the switch here: has_other_organizations is only a display hint. */}
            {requiresExplicitSwitch(failure?.code) && (
              <Button
                disabled={isSigningIn}
                icon={<Icon icon={ArrowRightLeftIcon} />}
                onClick={() => run(() => switchOrganization())}
              >
                {tOnboarding('screen5.actions.switchOrganization')}
              </Button>
            )}
          </Flexbox>
        )}
      </Flexbox>
    );
  },
);

AuthRequiredModalContent.displayName = 'AuthRequiredModalContent';

interface FooterProps {
  isSigningIn: boolean;
  onSignIn: () => void;
}

const AuthRequiredFooter = memo<FooterProps>(({ isSigningIn, onSignIn }) => {
  const { t } = useTranslation('auth');
  return (
    <ModalFooter>
      <Button icon={<Icon icon={LogIn} />} loading={isSigningIn} type="primary" onClick={onSignIn}>
        {isSigningIn ? t('authModal.signingIn') : t('authModal.signIn')}
      </Button>
    </ModalFooter>
  );
});
AuthRequiredFooter.displayName = 'AuthRequiredFooter';

const AuthRequiredModalTitle = memo(() => {
  const { t } = useTranslation('auth');

  return (
    <Flexbox horizontal align="center" gap={8}>
      <Icon icon={AlertCircle} />
      {t('authModal.title')}
    </Flexbox>
  );
});
AuthRequiredModalTitle.displayName = 'AuthRequiredModalTitle';

export const useAuthRequiredModal = () => {
  const instanceRef = useRef<ModalInstance | null>(null);

  const close = useCallback(() => {
    instanceRef.current?.close();
    instanceRef.current = null;
  }, []);

  const open = useCallback(() => {
    if (instanceRef.current) return;

    let isSigningIn = false;
    let signIn: () => Promise<void> = async () => {};

    const renderFooter = () => (
      <AuthRequiredFooter isSigningIn={isSigningIn} onSignIn={() => signIn()} />
    );

    instanceRef.current = createModal({
      content: (
        <AuthRequiredModalContent
          onActionReady={(api) => {
            signIn = api.signIn;
          }}
          onSigningInChange={(next) => {
            if (isSigningIn === next) return;
            isSigningIn = next;
            instanceRef.current?.update?.({
              footer: renderFooter(),
              maskClosable: false,
            } as Partial<ImperativeModalProps>);
          }}
        />
      ),
      footer: renderFooter(),
      maskClosable: false,
      onOpenChange: (nextOpen) => {
        if (!nextOpen) {
          instanceRef.current = null;
        }
      },
      title: <AuthRequiredModalTitle />,
    });
  }, []);

  return { close, open };
};

const AuthRequiredModal = memo(() => {
  const { close, open } = useAuthRequiredModal();
  const [isRemoteServerActive, refreshServerConfig, hasPendingConfirmation] = useElectronStore(
    (s) => [
      Boolean(s.dataSyncConfig?.active),
      s.refreshServerConfig,
      Boolean(s.pendingAuthorizationConfirmation),
    ],
  );

  useEffect(() => {
    if (isRemoteServerActive) close();
  }, [close, isRemoteServerActive]);

  // A verified login waits for the user's confirmation in the connection panel. Hand off to it:
  // the modal would otherwise cover the card, and its spinner would outlive the flow.
  useEffect(() => {
    if (hasPendingConfirmation) close();
  }, [close, hasPendingConfirmation]);

  useWatchBroadcast('authorizationConfirmRequired', () => {
    close();
  });

  useWatchBroadcast('authorizationSuccessful', () => {
    close();
    void refreshServerConfig();
  });

  useWatchBroadcast('authorizationRequired', (payload) => {
    const reason = payload?.reason ?? 'unknown';
    const state = useElectronStore.getState();
    if (state.isConnectionDrawerOpen) {
      log('authorizationRequired ignored (connection drawer open). reason=%s', reason);
      return;
    }
    if (state.pendingAuthorizationConfirmation) {
      log('authorizationRequired ignored (confirmation pending). reason=%s', reason);
      return;
    }
    // Wait until remote sync config has loaded once (avoid a flash before SWR resolves).
    // Do not gate on `dataSyncConfig.active`: after sign-out `active` is false but 401 + X-Auth-Required
    // still means the user must re-authenticate; gating on active would suppress the modal forever.
    if (!state.isInitRemoteServerConfig) {
      log(
        'authorizationRequired ignored (remote server config not initialized). reason=%s',
        reason,
      );
      return;
    }

    log('authorizationRequired: opening modal. reason=%s', reason);
    open();
  });

  return null;
});

AuthRequiredModal.displayName = 'AuthRequiredModal';

export default AuthRequiredModal;

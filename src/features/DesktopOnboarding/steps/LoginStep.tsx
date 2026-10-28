'use client';

import { type AuthorizationProgress } from '@lobechat/electron-client-ipc';
import { useWatchBroadcast } from '@lobechat/electron-client-ipc';
import { normalizeRemoteBaseUrl } from '@lobechat/utils/remoteUrl';
import { Alert, Button, Center, cssVar, Divider, Flexbox, Icon, Input, Text } from '@lobehub/ui';
import { ArrowRightLeftIcon, Cloud, LogOutIcon, Server, Undo2Icon } from 'lucide-react';
import { memo, useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import urlJoin from 'url-join';

import { OFFICIAL_SITE } from '@/const/url';
import { isDesktop } from '@/const/version';
import UserInfo from '@/features/User/UserInfo';
import { useIMECompositionEvent } from '@/hooks/useIMECompositionEvent';
import { useSignOut } from '@/hooks/useSignOut';
import { remoteServerService } from '@/services/electron/remoteServer';
import { electronSystemService } from '@/services/electron/system';
import { useElectronStore } from '@/store/electron';
import { type AuthorizationUiErrorCode } from '@/store/electron/initialState';
import { setDesktopAutoOidcFirstOpenHandled } from '@/utils/electron/autoOidc';

import {
  authorizationPhaseI18nKeyMap,
  canFindByOrganizationEmail,
  getAuthorizationErrorI18nKey,
  isSupersededAuthorization,
  requiresExplicitSwitch,
} from '../authorizationErrors';
import AuthorizationConfirmCard from '../components/AuthorizationConfirmCard';
import { AuthError, AuthNotice, AuthProgress } from '../components/AuthProgressPanel';
import LobeMessage from '../components/LobeMessage';
import OrganizationIdentity from '../components/OrganizationIdentity';
import ReloginRequiredPanel from '../components/ReloginRequiredPanel';
import { useAuthorizationConfirmation } from '../hooks/useAuthorizationConfirmation';
import { useAuthorizationEventsSync } from '../hooks/useAuthorizationEventsSync';
import { canOfferOrganizationSwitch } from '../organization';

const LEGACY_LOCAL_DB_MIGRATION_GUIDE_URL = urlJoin(
  OFFICIAL_SITE,
  '/docs/usage/migrate-from-local-database',
);

// Login method type
type LoginMethod = 'cloud' | 'selfhost';

// Login status type
type LoginStatus = 'idle' | 'loading' | 'success' | 'error';

const loginMethodMetas = {
  cloud: {
    descriptionKey: 'screen5.methods.cloud.description',
    icon: Cloud,
    id: 'cloud' as LoginMethod,
    nameKey: 'screen5.methods.cloud.name',
  },
  selfhost: {
    descriptionKey: 'screen5.methods.selfhost.description',
    icon: Server,
    id: 'selfhost' as LoginMethod,
    nameKey: 'screen5.methods.selfhost.name',
  },
} as const satisfies Record<LoginMethod, unknown>;

// `status` hosts render this step as a connection panel for already-signed-in users,
// where the wizard's "back" and "next" have no meaning.
type LoginStepMode = 'onboarding' | 'status';

interface LoginStepProps {
  mode?: LoginStepMode;
  onBack: () => void;
  onNext: () => void;
}

const LoginStep = memo<LoginStepProps>(({ mode = 'onboarding', onBack, onNext }) => {
  const { t } = useTranslation('desktop-onboarding');
  const [endpoint, setEndpoint] = useState('');
  const [cloudLoginStatus, setCloudLoginStatus] = useState<LoginStatus>('idle');
  const [authProgress, setAuthProgress] = useState<AuthorizationProgress | null>(null);
  const [selfhostLoginStatus, setSelfhostLoginStatus] = useState<LoginStatus>('idle');
  const [pendingLoginMethod, setPendingLoginMethod] = useState<LoginMethod | null>(null);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [remoteError, setRemoteError] = useState<string | null>(null);
  const [remoteErrorCode, setRemoteErrorCode] = useState<AuthorizationUiErrorCode | undefined>();
  const [restarting, setRestarting] = useState<{ attempt: number; maxAttempts: number } | null>(
    null,
  );
  const [isSwitchingOrganization, setIsSwitchingOrganization] = useState(false);
  const [showEndpoint, setShowEndpoint] = useState(false);
  const [hasLegacyLocalDb, setHasLegacyLocalDb] = useState(false);
  const [localRemainingSeconds, setLocalRemainingSeconds] = useState<number | null>(null);
  const { compositionProps, isComposingRef } = useIMECompositionEvent();

  const [
    dataSyncConfig,
    isConnectingServer,
    remoteServerSyncError,
    useDataSyncConfig,
    connectRemoteServer,
    refreshServerConfig,
    clearRemoteServerSyncError,
    requestPlatformAuthorization,
    switchOrganization,
    endpointNotice,
  ] = useElectronStore((s) => [
    s.dataSyncConfig,
    s.isConnectingServer,
    s.remoteServerSyncError,
    s.useDataSyncConfig,
    s.connectRemoteServer,
    s.refreshServerConfig,
    s.clearRemoteServerSyncError,
    s.requestPlatformAuthorization,
    s.switchOrganization,
    s.tenantEndpointChanged,
  ]);

  const signOut = useSignOut();

  useDataSyncConfig();
  useAuthorizationEventsSync();

  useEffect(() => {
    if (!isDesktop) return;

    let mounted = true;
    electronSystemService
      .hasLegacyLocalDb()
      .then((value) => {
        if (mounted) setHasLegacyLocalDb(value);
      })
      .catch(() => undefined);

    return () => {
      mounted = false;
    };
  }, []);

  const isCloudAuthed = !!dataSyncConfig?.active && dataSyncConfig.storageMode === 'cloud';
  const isSelfHostAuthed = !!dataSyncConfig?.active && dataSyncConfig.storageMode === 'selfHost';
  const authorizedLoginMethod: LoginMethod | null = isCloudAuthed
    ? 'cloud'
    : isSelfHostAuthed
      ? 'selfhost'
      : null;
  const isSelfHostEndpointVerified =
    isSelfHostAuthed &&
    !!endpoint.trim() &&
    // The main process stores the normalized address (no trailing slash, tenant
    // path kept), so compare the typed endpoint in the same form.
    normalizeRemoteBaseUrl(endpoint) ===
      normalizeRemoteBaseUrl(dataSyncConfig?.remoteServerUrl ?? '');

  const statusSuccessLoginMethod: LoginMethod | null =
    cloudLoginStatus === 'success' && selfhostLoginStatus === 'success'
      ? (pendingLoginMethod ?? authorizedLoginMethod)
      : cloudLoginStatus === 'success'
        ? 'cloud'
        : selfhostLoginStatus === 'success'
          ? 'selfhost'
          : null;
  const hasLocalLoginResult = cloudLoginStatus !== 'idle' || selfhostLoginStatus !== 'idle';

  const isLoginInFlight = cloudLoginStatus === 'loading' || selfhostLoginStatus === 'loading';
  // After the entry moved (409) the old session is paused: the "signed in" summary would be
  // misleading, so the notice replaces it until the user signs in again or updates the address.
  const showEndpointNotice = !!endpointNotice && !isLoginInFlight;

  // A switch / reconnect that failed (or was rejected, timed out, cancelled) never touched the
  // committed session, so the signed-in content stays and the failure becomes a notice on top.
  const hasLoginError = cloudLoginStatus === 'error' || selfhostLoginStatus === 'error';
  const keepsCommittedSession = !!authorizedLoginMethod && hasLoginError && !isLoginInFlight;

  const successLoginMethod =
    showEndpointNotice && endpointNotice === 'update_address_required'
      ? null
      : (statusSuccessLoginMethod ??
        (keepsCommittedSession || (!hasLocalLoginResult && !pendingLoginMethod)
          ? authorizedLoginMethod
          : null));

  // Determine if user can proceed (either method succeeding is sufficient)
  const canStart = () => {
    return !!successLoginMethod;
  };

  const resetAuthError = () => {
    setRemoteError(null);
    setRemoteErrorCode(undefined);
    clearRemoteServerSyncError();
  };

  // Close a failure notice: the signed-in content underneath was never replaced.
  const dismissAuthError = () => {
    resetAuthError();
    setCloudLoginStatus('idle');
    setSelfhostLoginStatus('idle');
  };

  // A login that was started elsewhere (or before this panel mounted) is still ours to show.
  const adoptLoginInFlight = () => {
    if (cloudLoginStatus !== 'idle' || selfhostLoginStatus !== 'idle') return;
    if (isCloudAuthed || isSelfHostAuthed) return;

    const method: LoginMethod = dataSyncConfig?.storageMode === 'selfHost' ? 'selfhost' : 'cloud';
    setPendingLoginMethod(method);
    if (method === 'cloud') setCloudLoginStatus('loading');
    else {
      setShowEndpoint(true);
      setSelfhostLoginStatus('loading');
    }
  };

  // The login ended without becoming active: show the reason the store recorded, if any.
  const handleAuthAborted = useCallback(() => {
    const failure = useElectronStore.getState().remoteServerSyncError;
    const method: LoginMethod =
      pendingLoginMethod ??
      (useElectronStore.getState().dataSyncConfig?.storageMode === 'selfHost'
        ? 'selfhost'
        : 'cloud');
    setPendingLoginMethod(null);
    setAuthProgress(null);
    setRestarting(null);

    if (failure?.message || failure?.code) {
      setRemoteError(failure.message ?? '');
      setRemoteErrorCode(failure.code);
      if (method === 'cloud') {
        setCloudLoginStatus('error');
        setSelfhostLoginStatus('idle');
      } else {
        setShowEndpoint(true);
        setSelfhostLoginStatus('error');
        setCloudLoginStatus('idle');
      }
      return;
    }

    setCloudLoginStatus('idle');
    setSelfhostLoginStatus('idle');
  }, [pendingLoginMethod]);

  const confirmation = useAuthorizationConfirmation({ onAborted: handleAuthAborted });

  // Handle cloud login
  const handleCloudLogin = async () => {
    if (!isDesktop) {
      setRemoteError(t('screen5.errors.desktopOnlyOidc'));
      setCloudLoginStatus('error');
      return;
    }

    resetAuthError();
    setPendingLoginMethod('cloud');
    setCloudLoginStatus('loading');
    setSelfhostLoginStatus('idle');
    setDesktopAutoOidcFirstOpenHandled();
    await connectRemoteServer({
      remoteServerUrl: dataSyncConfig?.remoteServerUrl,
      storageMode: 'cloud',
    });
  };

  // Handle self-hosted server connection
  const handleSelfhostConnect = async (urlOverride?: string) => {
    if (!isDesktop) {
      setRemoteError(t('screen5.errors.desktopOnlyOidc'));
      setSelfhostLoginStatus('error');
      return;
    }

    const url = (urlOverride ?? endpoint).trim();
    if (!url) return;

    resetAuthError();
    setPendingLoginMethod('selfhost');
    setCloudLoginStatus('idle');
    setSelfhostLoginStatus('loading');
    await connectRemoteServer({ remoteServerUrl: url, storageMode: 'selfHost' });
  };

  // Sign in again after the organization entry moved; main re-discovers the entry itself.
  const handleReloginAfterEndpointChange = async () => {
    if (dataSyncConfig?.storageMode === 'selfHost' && dataSyncConfig.remoteServerUrl) {
      setShowEndpoint(true);
      setEndpoint(dataSyncConfig.remoteServerUrl);
      await handleSelfhostConnect(dataSyncConfig.remoteServerUrl);
      return;
    }

    await handleCloudLogin();
  };

  // The typed address was not an organization: look the organization up by email instead.
  const handleFindByOrganizationEmail = async () => {
    resetAuthError();
    setPendingLoginMethod('cloud');
    setCloudLoginStatus('loading');
    setSelfhostLoginStatus('idle');
    await requestPlatformAuthorization();
  };

  // Sign out and pick an organization again, for both the status panel and recoverable errors.
  const handleSwitchOrganization = async () => {
    resetAuthError();
    setIsSwitchingOrganization(true);
    setPendingLoginMethod('cloud');
    setCloudLoginStatus('loading');
    setSelfhostLoginStatus('idle');
    try {
      await switchOrganization();
    } finally {
      setIsSwitchingOrganization(false);
    }
  };

  const handleSignOut = async () => {
    setIsSigningOut(true);
    try {
      await signOut();
    } finally {
      setIsSigningOut(false);
    }
  };

  // Sync local UI status with real remote config
  useEffect(() => {
    if (isCloudAuthed) {
      setCloudLoginStatus('success');
      setSelfhostLoginStatus('idle');
      setPendingLoginMethod(null);
    } else if (isSelfHostAuthed) {
      setSelfhostLoginStatus('success');
      setCloudLoginStatus('idle');
      setPendingLoginMethod(null);
    }
  }, [isCloudAuthed, isSelfHostAuthed]);

  useEffect(() => {
    if (!isSelfHostAuthed || endpoint.trim()) return;
    setEndpoint(dataSyncConfig?.remoteServerUrl ?? '');
  }, [dataSyncConfig?.remoteServerUrl, endpoint, isSelfHostAuthed]);

  // The server moved and the saved address is dead: start from it so only the part that
  // changed needs editing.
  useEffect(() => {
    if (endpointNotice !== 'update_address_required' || endpoint.trim()) return;
    setEndpoint(dataSyncConfig?.remoteServerUrl ?? '');
  }, [dataSyncConfig?.remoteServerUrl, endpoint, endpointNotice]);

  // If user changes self-host endpoint after success, require re-authorization.
  useEffect(() => {
    if (selfhostLoginStatus !== 'success') return;
    if (isSelfHostEndpointVerified) return;
    setSelfhostLoginStatus('idle');
  }, [isSelfHostEndpointVerified, selfhostLoginStatus]);

  // Surface requestAuthorization errors reported via store
  useEffect(() => {
    const message = remoteServerSyncError?.message;
    if (!message) return;
    setRemoteError(message);
    setRemoteErrorCode(remoteServerSyncError?.code);
    setPendingLoginMethod(null);
    if (cloudLoginStatus === 'loading') setCloudLoginStatus('error');
    if (selfhostLoginStatus === 'loading') setSelfhostLoginStatus('error');
  }, [
    remoteServerSyncError?.message,
    remoteServerSyncError?.code,
    cloudLoginStatus,
    selfhostLoginStatus,
  ]);

  // Watch broadcasts from main process (polling result)
  useWatchBroadcast('authorizationSuccessful', async () => {
    resetAuthError();
    setAuthProgress(null);
    setRestarting(null);
    if (pendingLoginMethod === 'cloud') {
      setCloudLoginStatus('success');
      setSelfhostLoginStatus('idle');
    } else if (pendingLoginMethod === 'selfhost') {
      setSelfhostLoginStatus('success');
      setCloudLoginStatus('idle');
    }
    setPendingLoginMethod(null);
    await refreshServerConfig();
  });

  useWatchBroadcast('authorizationFailed', ({ code, error }) => {
    // An older flow lost to a newer one: the newer one is still running.
    if (isSupersededAuthorization(code)) return;

    setRemoteError(error);
    setRemoteErrorCode(code);
    setAuthProgress(null);
    setRestarting(null);
    setPendingLoginMethod(null);
    if (cloudLoginStatus === 'loading') setCloudLoginStatus('error');
    if (selfhostLoginStatus === 'loading') setSelfhostLoginStatus('error');
  });

  useWatchBroadcast('authorizationProgress', (progress) => {
    setAuthProgress(progress);
    if (progress.phase === 'cancelled') {
      setCloudLoginStatus('idle');
      setSelfhostLoginStatus('idle');
      setPendingLoginMethod(null);
      setAuthProgress(null);
      setRestarting(null);
      return;
    }

    setRestarting(null);
    adoptLoginInFlight();
  });

  // Entry moved mid-login: main restarts the flow itself, so keep the loading state with a hint.
  useWatchBroadcast('authorizationRestarting', ({ attempt, maxAttempts }) => {
    setRestarting({ attempt, maxAttempts });
    adoptLoginInFlight();
  });

  // Sync local countdown from authProgress
  useEffect(() => {
    if (authProgress) {
      const seconds = Math.max(
        0,
        Math.ceil((authProgress.maxPollTime - authProgress.elapsed) / 1000),
      );
      setLocalRemainingSeconds(seconds);
    } else {
      setLocalRemainingSeconds(null);
    }
  }, [authProgress]);

  // Decrement local countdown every second for smooth UI updates
  useEffect(() => {
    if (localRemainingSeconds === null || localRemainingSeconds <= 0) return;

    const timer = setTimeout(() => {
      setLocalRemainingSeconds((prev) => {
        if (prev === null || prev <= 0) return prev;
        return prev - 1;
      });
    }, 1000);

    return () => clearTimeout(timer);
  }, [localRemainingSeconds]);

  const handleCancelAuth = async () => {
    resetAuthError();

    setCloudLoginStatus('idle');
    setSelfhostLoginStatus('idle');
    setPendingLoginMethod(null);
    setAuthProgress(null);
    setRestarting(null);
    await remoteServerService.cancelAuthorization();
  };

  const getAuthErrorMessage = () => {
    const codeKey = getAuthorizationErrorI18nKey(remoteErrorCode);

    return codeKey
      ? t(codeKey)
      : remoteError?.toLowerCase().includes('timed out')
        ? t('screen5.errors.timedOut')
        : remoteError || t('authResult.failed.desc');
  };

  const renderSuccessContent = (method: LoginMethod) => {
    const isStatusMode = mode === 'status';
    const serverUrl = dataSyncConfig?.remoteServerUrl;
    const cloudTenant = dataSyncConfig?.cloudTenant;
    const isBusy = isSigningOut || isSwitchingOrganization;
    const showFailureNotice = keepsCommittedSession && method === authorizedLoginMethod;
    // An explicit switch demanded by the failure lives in the notice; otherwise the regular
    // switch button below is the way to retry.
    const noticeOffersSwitch =
      showFailureNotice && method === 'cloud' && requiresExplicitSwitch(remoteErrorCode);

    const title = isStatusMode
      ? [method === 'cloud' ? t('screen5.status.cloud.title') : t('screen5.status.selfhost.title')]
      : [t('screen5.title'), t('screen5.title2'), t('screen5.title3')];

    const description = !isStatusMode
      ? t('screen5.description')
      : method === 'selfhost' && serverUrl
        ? t('screen5.status.selfhost.description', { url: serverUrl })
        : t('screen5.status.description');

    return (
      <Center gap={32} style={{ height: '100%', minHeight: '100%' }}>
        <Flexbox align={'flex-start'} justify={'flex-start'} style={{ width: '100%' }}>
          <LobeMessage sentences={title} />
          <Text as={'p'}>{description}</Text>
        </Flexbox>

        <Flexbox gap={16} style={{ width: '100%' }}>
          {showFailureNotice && (
            <AuthNotice
              isBusy={!!isConnectingServer || isBusy}
              message={getAuthErrorMessage()}
              onDismiss={dismissAuthError}
              onSwitchOrganization={noticeOffersSwitch ? handleSwitchOrganization : undefined}
            />
          )}
          <UserInfo
            style={{
              background: cssVar.colorFillSecondary,
              borderRadius: 8,
            }}
          />
          {cloudTenant && (
            <OrganizationIdentity
              account={cloudTenant.display.account}
              entryUrl={cloudTenant.entryUrl}
              organizationName={cloudTenant.display.organizationName}
              organizationSlug={cloudTenant.display.organizationSlug}
            />
          )}
        </Flexbox>

        <Flexbox horizontal justify={'space-between'} style={{ marginTop: 32 }}>
          {isStatusMode ? (
            <Flexbox horizontal gap={4}>
              <Button
                disabled={isBusy}
                icon={LogOutIcon}
                style={{ color: cssVar.colorTextDescription }}
                type={'text'}
                onClick={handleSignOut}
              >
                {isSigningOut ? t('screen5.actions.signingOut') : t('screen5.actions.signOut')}
              </Button>
              {method === 'cloud' &&
                !noticeOffersSwitch &&
                canOfferOrganizationSwitch(cloudTenant?.display.hasOtherOrganizations) && (
                  <Button
                    disabled={isBusy}
                    icon={ArrowRightLeftIcon}
                    style={{ color: cssVar.colorTextDescription }}
                    type={'text'}
                    onClick={handleSwitchOrganization}
                  >
                    {t('screen5.actions.switchOrganization')}
                  </Button>
                )}
            </Flexbox>
          ) : (
            <Button
              icon={Undo2Icon}
              style={{ color: cssVar.colorTextDescription }}
              type={'text'}
              onClick={onBack}
            >
              {t('back')}
            </Button>
          )}
          <Button type={'primary'} onClick={onNext}>
            {isStatusMode ? t('screen5.actions.done') : t('next')}
          </Button>
        </Flexbox>
      </Center>
    );
  };

  const renderPhaseText = (fallback: string) =>
    restarting
      ? t('screen5.auth.phase.restarting', {
          attempt: restarting.attempt,
          max: restarting.maxAttempts,
        })
      : t(authorizationPhaseI18nKeyMap[authProgress?.phase ?? 'browser_opened'], {
          defaultValue: fallback,
        });

  // Failure reason by code; unknown or code-less errors keep the previous behaviour.
  const renderAuthError = (method: LoginMethod) => {
    const errorMessage = getAuthErrorMessage();

    const retry = () => {
      resetAuthError();
      if (method === 'cloud') setCloudLoginStatus('idle');
      else setSelfhostLoginStatus('idle');
    };

    return (
      <AuthError
        canFindByEmail={canFindByOrganizationEmail(remoteErrorCode)}
        isBusy={!!isConnectingServer || isSwitchingOrganization}
        message={errorMessage}
        method={method}
        requiresSwitch={requiresExplicitSwitch(remoteErrorCode)}
        retryLabel={
          remoteErrorCode === 'COMMIT_FAILED'
            ? t('screen5.actions.signInAgain')
            : t('screen5.actions.tryAgain')
        }
        onFindByEmail={handleFindByOrganizationEmail}
        onRetry={retry}
        onSwitchOrganization={handleSwitchOrganization}
      />
    );
  };

  // Render Cloud login content
  const renderCloudContent = () => {
    if (cloudLoginStatus === 'error') return renderAuthError('cloud');

    if (cloudLoginStatus === 'loading') {
      const phaseText = renderPhaseText(t('screen5.actions.signingIn'));

      return (
        <AuthProgress
          label={t('screen5.actions.signingIn')}
          method={'cloud'}
          phaseText={phaseText}
          remainingSeconds={localRemainingSeconds}
          onCancel={handleCancelAuth}
        />
      );
    }

    return (
      <Button
        block
        disabled={isConnectingServer}
        icon={Cloud}
        loading={false}
        size={'large'}
        type={'primary'}
        onClick={handleCloudLogin}
      >
        {t('screen5.actions.signInCloud')}
      </Button>
    );
  };

  // Render Self-host login content
  const renderSelfhostContent = () => {
    if (selfhostLoginStatus === 'error') return renderAuthError('selfhost');

    if (selfhostLoginStatus === 'loading') {
      const phaseText = renderPhaseText(t('screen5.actions.connecting'));

      return (
        <AuthProgress
          label={t('screen5.actions.connecting')}
          method={'selfhost'}
          phaseText={phaseText}
          remainingSeconds={localRemainingSeconds}
          onCancel={handleCancelAuth}
        />
      );
    }

    return (
      <Flexbox gap={16} style={{ width: '100%' }}>
        <Text color={cssVar.colorTextSecondary}>{t(loginMethodMetas.selfhost.descriptionKey)}</Text>
        <Input
          placeholder={t('screen5.selfhost.endpointPlaceholder')}
          prefix={<Icon icon={Server} style={{ marginRight: 4 }} />}
          size={'large'}
          style={{ width: '100%' }}
          value={endpoint}
          onChange={(e) => setEndpoint(e.target.value)}
          {...compositionProps}
          onContextMenu={async (e) => {
            if (!isDesktop) return;
            e.preventDefault();
            const { electronSystemService } = await import('@/services/electron/system');
            const input = e.target as HTMLInputElement;
            const selectionText = input.value.slice(
              input.selectionStart || 0,
              input.selectionEnd || 0,
            );
            await electronSystemService.showContextMenu('editor', {
              selectionText: selectionText || undefined,
            });
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !isComposingRef.current) {
              handleSelfhostConnect();
            }
          }}
        />
        <Button
          disabled={!endpoint.trim() || isConnectingServer}
          loading={false}
          size={'large'}
          style={{ width: '100%' }}
          type={'primary'}
          onClick={() => handleSelfhostConnect()}
        >
          {t('screen5.actions.connectToServer')}
        </Button>
      </Flexbox>
    );
  };

  if (confirmation.request) {
    return (
      <Center gap={32} style={{ height: '100%', minHeight: '100%' }}>
        <AuthorizationConfirmCard
          busy={confirmation.busy}
          request={confirmation.request}
          onCancel={confirmation.cancel}
          onConfirm={confirmation.confirm}
          onSwitchOrganization={confirmation.switchOrganization}
        />
      </Center>
    );
  }

  if (showEndpointNotice && endpointNotice === 'relogin_required') {
    return (
      <ReloginRequiredPanel
        cloudTenant={dataSyncConfig?.cloudTenant}
        isConnecting={!!isConnectingServer}
        isSigningOut={isSigningOut}
        failure={
          hasLoginError
            ? { message: getAuthErrorMessage(), onDismiss: dismissAuthError }
            : undefined
        }
        onRelogin={handleReloginAfterEndpointChange}
        onSignOut={handleSignOut}
      />
    );
  }

  if (successLoginMethod) return renderSuccessContent(successLoginMethod);

  const mustUpdateAddress = showEndpointNotice && endpointNotice === 'update_address_required';

  return (
    <Center gap={32} style={{ height: '100%', minHeight: '100%' }}>
      <Flexbox align={'flex-start'} gap={8} justify={'flex-start'} style={{ width: '100%' }}>
        {mustUpdateAddress ? (
          <>
            <LobeMessage sentences={[t('screen5.endpointChanged.updateAddress.title')]} />
            <Alert
              description={t('screen5.endpointChanged.updateAddress.description')}
              type={'warning'}
            />
          </>
        ) : (
          <>
            <LobeMessage
              sentences={[t('screen5.title'), t('screen5.title2'), t('screen5.title3')]}
            />
            <Text as={'p'}>{t('screen5.description')}</Text>
          </>
        )}
      </Flexbox>

      <Flexbox align={'flex-start'} gap={16} style={{ width: '100%' }} width={'100%'}>
        {renderCloudContent()}
        <Flexbox horizontal justify={'center'} style={{ width: '100%' }}>
          {hasLegacyLocalDb && (
            <Button
              style={{ padding: 0 }}
              type={'link'}
              onClick={() =>
                electronSystemService.openExternalLink(LEGACY_LOCAL_DB_MIGRATION_GUIDE_URL)
              }
            >
              {t('screen5.legacyLocalDb.link', 'Migrate legacy local database')}
            </Button>
          )}
        </Flexbox>
        {!showEndpoint && !mustUpdateAddress ? (
          <Center width={'100%'}>
            <Button
              type={'text'}
              style={{
                color: cssVar.colorTextSecondary,
              }}
              onClick={() => setShowEndpoint(true)}
            >
              {t(loginMethodMetas.selfhost.descriptionKey)}
            </Button>
          </Center>
        ) : (
          <>
            <Divider style={{ marginBlock: 16 }}>
              <Text fontSize={12} type={'secondary'}>
                OR
              </Text>
            </Divider>

            {/* Self-host option */}
            {renderSelfhostContent()}
          </>
        )}
      </Flexbox>
      {canStart() && (
        <Flexbox horizontal justify={'space-between'} style={{ marginTop: 32 }}>
          <Button
            icon={Undo2Icon}
            style={{ color: cssVar.colorTextDescription }}
            type={'text'}
            onClick={onBack}
          >
            {t('back')}
          </Button>
          <Button type={'primary'} onClick={onNext}>
            {t('next')}
          </Button>
        </Flexbox>
      )}
    </Center>
  );
});

LoginStep.displayName = 'LoginStep';

export default LoginStep;

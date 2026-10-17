'use client';

import { useWatchBroadcast } from '@lobechat/electron-client-ipc';
import { useEffect } from 'react';

import { isDesktop } from '@/const/version';
import { remoteServerService } from '@/services/electron/remoteServer';
import { useElectronStore } from '@/store/electron';

/**
 * Mirrors the main process's confirmation / endpoint-change state into the electron store, so
 * whichever panel is mounted (onboarding step, connection drawer) renders the same truth.
 *
 * Several hosts may mount this at once: every write is idempotent and keyed by confirmationId.
 * On mount it pulls the pending confirmation, because the broadcast may have fired before this
 * window or panel existed (reload, late mount).
 */
export const useAuthorizationEventsSync = () => {
  const [
    setPendingAuthorizationConfirmation,
    dismissAuthorizationConfirmation,
    setTenantEndpointChanged,
  ] = useElectronStore((s) => [
    s.setPendingAuthorizationConfirmation,
    s.dismissAuthorizationConfirmation,
    s.setTenantEndpointChanged,
  ]);

  useEffect(() => {
    if (!isDesktop) return;

    let active = true;
    remoteServerService
      .getPendingAuthorizationConfirmation()
      .then((pending) => {
        if (active && pending) setPendingAuthorizationConfirmation(pending);
      })
      .catch((error) => {
        console.error('Failed to load pending authorization confirmation:', error);
      });

    return () => {
      active = false;
    };
  }, [setPendingAuthorizationConfirmation]);

  useWatchBroadcast('authorizationConfirmRequired', (request) => {
    setPendingAuthorizationConfirmation(request);
  });

  useWatchBroadcast('authorizationConfirmDismissed', ({ confirmationId }) => {
    dismissAuthorizationConfirmation(confirmationId);
  });

  useWatchBroadcast('tenantEndpointChanged', ({ kind }) => {
    setTenantEndpointChanged(kind);
  });

  // A committed login ends any pending confirmation and the paused-session notice.
  useWatchBroadcast('authorizationSuccessful', () => {
    setTenantEndpointChanged(undefined);
    useElectronStore.setState({ pendingAuthorizationConfirmation: undefined });
  });
};

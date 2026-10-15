'use client';

import { type AuthorizationConfirmRequest } from '@lobechat/electron-client-ipc';
import { useCallback, useEffect, useState } from 'react';

import { useElectronStore } from '@/store/electron';

export type ConfirmationAction = 'cancel' | 'confirm' | 'switch';

interface UseAuthorizationConfirmationOptions {
  /** The login ended without becoming active (cancelled, replaced by an error); reset local UI. */
  onAborted?: () => void;
}

/** State and replies for the confirmation card. Replies carry only confirmationId and generation. */
export const useAuthorizationConfirmation = ({
  onAborted,
}: UseAuthorizationConfirmationOptions = {}) => {
  const [
    request,
    confirmAuthorization,
    cancelAuthorizationConfirmation,
    switchAuthorizationOrganization,
  ] = useElectronStore((s) => [
    s.pendingAuthorizationConfirmation,
    s.confirmAuthorization,
    s.cancelAuthorizationConfirmation,
    s.switchAuthorizationOrganization,
  ]);

  const [busy, setBusy] = useState<ConfirmationAction | null>(null);

  const confirmationId = request?.confirmationId;
  // A different confirmation is a new decision: drop busy left from the previous one.
  useEffect(() => {
    setBusy(null);
  }, [confirmationId]);

  const confirm = useCallback(async () => {
    setBusy('confirm');
    try {
      const result = await confirmAuthorization();
      if (result.success) return;

      // Cancelled, expired, replaced or a failed commit (main consumes the pending record in
      // every case): the login panel shows the reason from the store.
      onAborted?.();
    } finally {
      setBusy(null);
    }
  }, [confirmAuthorization, onAborted]);

  const cancel = useCallback(async () => {
    setBusy('cancel');
    try {
      await cancelAuthorizationConfirmation();
      onAborted?.();
    } finally {
      setBusy(null);
    }
  }, [cancelAuthorizationConfirmation, onAborted]);

  const switchOrganization = useCallback(async () => {
    setBusy('switch');
    try {
      const result = await switchAuthorizationOrganization();
      // On success a new platform flow is already running, so the panel stays in "signing in".
      // A superseded request means a newer sign-in is already running: keep showing that one.
      if (!result.success && result.code !== 'FLOW_SUPERSEDED') onAborted?.();
    } finally {
      setBusy(null);
    }
  }, [onAborted, switchAuthorizationOrganization]);

  return {
    busy,
    cancel,
    confirm,
    request: request as AuthorizationConfirmRequest | undefined,
    switchOrganization,
  };
};

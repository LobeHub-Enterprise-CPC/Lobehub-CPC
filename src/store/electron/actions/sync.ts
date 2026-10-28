import { isDesktop } from '@lobechat/const';
import {
  type AuthorizationConfirmRequest,
  type AuthorizationConfirmResult,
  type AuthorizationStartResult,
  type DataSyncConfig,
  type TenantEndpointChangedKind,
} from '@lobechat/electron-client-ipc';
import isEqual from 'fast-deep-equal';
import { type SWRResponse } from 'swr';
import useSWR from 'swr';

import { mutate } from '@/libs/swr';
import { electronKeys } from '@/libs/swr/keys';
import { remoteServerService } from '@/services/electron/remoteServer';
import { type StoreSetter } from '@/store/types';
import { useUserStore } from '@/store/user';

import { type ElectronStore } from '../store';

/** A newer request replaced this one; the newer request's state is what the UI should show. */
const isSuperseded = (result: AuthorizationStartResult) =>
  !result.success && result.code === 'FLOW_SUPERSEDED';

/**
 * Remote server actions
 */

type Setter = StoreSetter<ElectronStore>;
export const remoteSyncSlice = (set: Setter, get: () => ElectronStore, _api?: unknown) =>
  new ElectronRemoteServerActionImpl(set, get, _api);

export class ElectronRemoteServerActionImpl {
  readonly #get: () => ElectronStore;
  readonly #set: Setter;

  constructor(set: Setter, get: () => ElectronStore, _api?: unknown) {
    void _api;
    this.#set = set;
    this.#get = get;
  }

  clearRemoteServerSyncError = (): void => {
    this.#set({ remoteServerSyncError: undefined }, false, 'clearRemoteServerSyncError');
  };

  /**
   * Drop the pending confirmation only if it is still the one the caller saw: a newer
   * request may have replaced it while a reply was in flight.
   */
  dismissAuthorizationConfirmation = (confirmationId: string): void => {
    if (this.#get().pendingAuthorizationConfirmation?.confirmationId !== confirmationId) return;

    this.#set(
      { pendingAuthorizationConfirmation: undefined },
      false,
      'dismissAuthorizationConfirmation',
    );
  };

  /** Confirm the pending login. Only the confirmation id and generation go back to main. */
  confirmAuthorization = async (): Promise<AuthorizationConfirmResult> => {
    const pending = this.#get().pendingAuthorizationConfirmation;
    if (!pending) {
      return { code: 'CONFIRMATION_INVALID', error: 'No pending confirmation', success: false };
    }

    const { confirmationId, generation } = pending;
    let result: AuthorizationConfirmResult;
    try {
      result = await remoteServerService.confirmAuthorization({ confirmationId, generation });
    } catch (error) {
      console.error('Failed to confirm authorization:', error);
      return { code: 'COMMIT_FAILED', error: (error as Error).message, success: false };
    }

    if (result.success) {
      this.#get().dismissAuthorizationConfirmation(confirmationId);
      this.#set({ tenantEndpointChanged: undefined }, false, 'confirmAuthorization');
      await this.#get().refreshServerConfig();
    } else {
      // The pending record is gone in main (cancelled, expired, replaced, or consumed by a
      // failed commit): the card cannot be confirmed again, so surface the reason on the
      // login panel instead.
      this.#get().dismissAuthorizationConfirmation(confirmationId);
      this.#set(
        { remoteServerSyncError: { code: result.code, message: result.error, type: 'AUTH_ERROR' } },
        false,
        'confirmAuthorization',
      );
    }

    return result;
  };

  cancelAuthorizationConfirmation = async (): Promise<void> => {
    const pending = this.#get().pendingAuthorizationConfirmation;
    if (!pending) return;

    const { confirmationId, generation } = pending;
    try {
      await remoteServerService.cancelAuthorizationConfirmation({ confirmationId, generation });
    } catch (error) {
      console.error('Failed to cancel authorization confirmation:', error);
    } finally {
      this.#get().dismissAuthorizationConfirmation(confirmationId);
    }
  };

  /** "Choose another organization" on the confirmation card; the current session stays active. */
  switchAuthorizationOrganization = async (): Promise<AuthorizationStartResult> => {
    const pending = this.#get().pendingAuthorizationConfirmation;
    if (!pending) {
      return { code: 'FLOW_SUPERSEDED', error: 'No pending confirmation', success: false };
    }

    const { confirmationId, generation } = pending;
    this.#get().clearRemoteServerSyncError();
    let result: AuthorizationStartResult;
    try {
      result = await remoteServerService.switchAuthorizationOrganization({
        confirmationId,
        generation,
      });
    } catch (error) {
      console.error('Failed to switch organization from confirmation:', error);
      result = { error: (error as Error).message, success: false };
    }

    this.#get().dismissAuthorizationConfirmation(confirmationId);
    if (!result.success && !isSuperseded(result)) {
      this.#set(
        { remoteServerSyncError: { code: result.code, message: result.error, type: 'AUTH_ERROR' } },
        false,
        'switchAuthorizationOrganization',
      );
    }

    return result;
  };

  connectRemoteServer = async (values: DataSyncConfig): Promise<void> => {
    if (values.storageMode === 'selfHost' && !values.remoteServerUrl) return;

    this.#set({ isConnectingServer: true });
    this.#get().clearRemoteServerSyncError();
    try {
      // The committed session is never touched before the new login is confirmed: the typed
      // config is only the input of this flow, and main persists it with the confirmed identity.
      const result = await remoteServerService.requestAuthorization(values);

      if (!result.success && !isSuperseded(result)) {
        console.error('Authorization request failed:', result.error);

        this.#set({
          remoteServerSyncError: { code: result.code, message: result.error, type: 'AUTH_ERROR' },
        });
      }
      // Refresh state
      await this.#get().refreshServerConfig();
    } catch (error) {
      console.error('Remote server configuration error:', error);
      this.#set({
        remoteServerSyncError: { message: (error as Error).message, type: 'CONFIG_ERROR' },
      });
    } finally {
      this.#set({ isConnectingServer: false });
    }
  };

  disconnectRemoteServer = async (): Promise<void> => {
    this.#set({ isConnectingServer: false });
    this.#get().clearRemoteServerSyncError();
    try {
      // Must use clearRemoteServerConfig (not only set active: false): main process
      // clears encrypted OIDC access/refresh tokens; otherwise sign-out still leaves auth state.
      await remoteServerService.clearRemoteServerConfig();
      this.#set(
        { pendingAuthorizationConfirmation: undefined, tenantEndpointChanged: undefined },
        false,
        'disconnectRemoteServer',
      );
      const { stores } = await import('@/store/utils/userDataStores');
      stores.reset();
      await this.#get().refreshServerConfig();
    } catch (error) {
      console.error('Disconnect failed:', error);
      this.#set({
        remoteServerSyncError: { message: (error as Error).message, type: 'DISCONNECT_ERROR' },
      });
    } finally {
      this.#set({ isConnectingServer: false });
    }
  };

  /** Force the platform flow, e.g. when a typed organization address turned out to be invalid. */
  requestPlatformAuthorization = async (options?: {
    switchOrganization?: boolean;
  }): Promise<void> => {
    this.#set({ isConnectingServer: true });
    this.#get().clearRemoteServerSyncError();
    try {
      const result = await remoteServerService.requestPlatformAuthorization(options);

      if (!result.success && !isSuperseded(result)) {
        console.error('Platform authorization request failed:', result.error);
        this.#set({
          remoteServerSyncError: { code: result.code, message: result.error, type: 'AUTH_ERROR' },
        });
      }
      await this.#get().refreshServerConfig();
    } catch (error) {
      console.error('Platform authorization error:', error);
      this.#set({
        remoteServerSyncError: { message: (error as Error).message, type: 'CONFIG_ERROR' },
      });
    } finally {
      this.#set({ isConnectingServer: false });
    }
  };

  refreshServerConfig = async (): Promise<void> => {
    await mutate(electronKeys.remoteServerConfig());
  };

  refreshUserData = async (): Promise<void> => {
    const { stores } = await import('@/store/utils/userDataStores');
    stores.reset();

    const { useChatStore } = await import('@/store/chat');
    await useChatStore.getState().refreshMessages();
    await useChatStore.getState().refreshTopic();
    await useUserStore.getState().refreshUserState();
  };

  setPendingAuthorizationConfirmation = (request?: AuthorizationConfirmRequest): void => {
    this.#set({ pendingAuthorizationConfirmation: request }, false, 'setPendingAuthorization');
  };

  setTenantEndpointChanged = (kind?: TenantEndpointChangedKind): void => {
    this.#set({ tenantEndpointChanged: kind }, false, 'setTenantEndpointChanged');
  };

  /**
   * "Switch organization": main only starts a new platform flow in switch mode. The current
   * session (tokens, config, refresh, gateway) and its user data stay as they are until the
   * new login is confirmed; the commit changes the config, which resets user data then.
   */
  switchOrganization = async (): Promise<void> => {
    this.#set({ isConnectingServer: true });
    this.#get().clearRemoteServerSyncError();
    try {
      const result = await remoteServerService.switchOrganization();
      // Main discarded any confirmation card it was showing when the new flow began.
      this.#set({ pendingAuthorizationConfirmation: undefined }, false, 'switchOrganization');

      if (!result.success && !isSuperseded(result)) {
        console.error('Switch organization failed:', result.error);
        this.#set({
          remoteServerSyncError: { code: result.code, message: result.error, type: 'AUTH_ERROR' },
        });
      }
      await this.#get().refreshServerConfig();
    } catch (error) {
      console.error('Switch organization error:', error);
      this.#set({
        remoteServerSyncError: { message: (error as Error).message, type: 'CONFIG_ERROR' },
      });
    } finally {
      this.#set({ isConnectingServer: false });
    }
  };

  useDataSyncConfig = (): SWRResponse => {
    return useSWR<DataSyncConfig>(
      // Desktop-only IPC: on web there is no electronAPI, so never fetch off-desktop.
      isDesktop ? electronKeys.remoteServerConfig() : null,
      async () => {
        try {
          return await remoteServerService.getRemoteServerConfig();
        } catch (error) {
          console.error('Failed to get remote server configuration:', error);
          throw error;
        }
      },
      {
        onSuccess: (data) => {
          const { dataSyncConfig, isInitRemoteServerConfig } = this.#get();
          // Only refresh on genuine config changes AFTER the first hydration.
          // On initial load the stores are already fresh, and `refreshUserData`
          // runs `stores.reset()` which wipes chat state (notably `activeAgentId`)
          // that `AgentIdSync` just set from the URL — leaving the topic list
          // unable to resolve its agent scope on reload.
          if (isInitRemoteServerConfig && !isEqual(data, dataSyncConfig)) {
            void this.#get()
              .refreshUserData()
              .catch((error) => {
                console.error('Failed to refresh user data:', error);
              });
          }

          // Signed out for good (no session and no remembered organization): a stale
          // "address changed" notice would have nothing left to act on.
          const endpointNoticeStale =
            !!this.#get().tenantEndpointChanged && !data.active && !data.cloudTenant;

          this.#set(
            {
              dataSyncConfig: data,
              isInitRemoteServerConfig: true,
              ...(endpointNoticeStale && { tenantEndpointChanged: undefined }),
            },
            false,
            'useDataSyncConfig',
          );
        },
      },
    );
  };
}

export type ElectronRemoteServerAction = Pick<
  ElectronRemoteServerActionImpl,
  keyof ElectronRemoteServerActionImpl
>;

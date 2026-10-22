import {
  type AuthorizationConfirmRequest,
  type AuthorizationConfirmResult,
  type AuthorizationErrorCode,
  type DataSyncConfig,
  type ElectronAppState,
  type GatewayConnectionError,
  type GatewayConnectionStatus,
  type NetworkProxySettings,
  type TenantEndpointChangedKind,
} from '@lobechat/electron-client-ipc';

import { type CurrentRouteMetaState } from './actions/currentRouteMeta';
import { currentRouteMetaInitialState } from './actions/currentRouteMeta';
import { type GatewayDeviceInfo } from './actions/gateway';
import { type RecentPagesState } from './actions/recentPages';
import { recentPagesInitialState } from './actions/recentPages';
import { type TabPagesState } from './actions/tabPages';
import { tabPagesInitialState } from './actions/tabPages';

export type RemoteServerError = 'CONFIG_ERROR' | 'AUTH_ERROR' | 'DISCONNECT_ERROR';

/** Authorization failure codes the UI maps to copy: the broadcast codes plus confirm-step failures. */
export type AuthorizationUiErrorCode =
  AuthorizationErrorCode | Extract<AuthorizationConfirmResult, { success: false }>['code'];

export const defaultProxySettings: NetworkProxySettings = {
  enableProxy: false,
  proxyBypass: 'localhost, 127.0.0.1, ::1',
  proxyPort: '',
  proxyRequireAuth: false,
  proxyServer: '',
  proxyType: 'http',
};

export interface ElectronState extends CurrentRouteMetaState, RecentPagesState, TabPagesState {
  appState: ElectronAppState;
  appTrayVisible: boolean;
  dataSyncConfig: DataSyncConfig;
  desktopHotkeys: Record<string, string>;
  /** Why the last connection attempt ended, as reported by the main process. */
  gatewayConnectionError?: GatewayConnectionError;
  gatewayConnectionStatus: GatewayConnectionStatus;
  gatewayDeviceInfo?: GatewayDeviceInfo;
  isAppStateInit?: boolean;
  isConnectingServer?: boolean;
  isConnectionDrawerOpen?: boolean;
  isDesktopHotkeysInit: boolean;
  isInitRemoteServerConfig: boolean;
  isSyncActive?: boolean;
  /** Verified login waiting for the user to confirm organization and account. */
  pendingAuthorizationConfirmation?: AuthorizationConfirmRequest;
  proxySettings: NetworkProxySettings;
  remoteServerSyncError?: {
    /** Stable code from the main process; the UI maps it to copy. */
    code?: AuthorizationUiErrorCode;
    message?: string;
    type: RemoteServerError;
  };
  /** The signed-in organization entry moved (409); remote activity is paused. */
  tenantEndpointChanged?: TenantEndpointChangedKind;
}

export const initialState: ElectronState = {
  ...currentRouteMetaInitialState,
  ...recentPagesInitialState,
  ...tabPagesInitialState,
  appState: {},
  appTrayVisible: true,
  dataSyncConfig: { storageMode: 'cloud' },
  desktopHotkeys: {},
  gatewayConnectionStatus: 'disconnected',
  isAppStateInit: false,
  isConnectingServer: false,
  isConnectionDrawerOpen: false,
  isDesktopHotkeysInit: false,
  isInitRemoteServerConfig: false,
  isSyncActive: false,
  proxySettings: defaultProxySettings,
};

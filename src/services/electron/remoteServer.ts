import {
  type AuthorizationConfirmParams,
  type DataSyncConfig,
  type MarketAuthorizationParams,
} from '@lobechat/electron-client-ipc';

import { ensureElectronIpc } from '@/utils/electron/ipc';

class RemoteServerService {
  /**
   * Get remote server configuration
   */
  getRemoteServerConfig = async () => {
    return ensureElectronIpc().remoteServer.getRemoteServerConfig();
  };

  isRemoteServerConfigured = async () => {
    return ensureElectronIpc().remoteServer.isRemoteServerConfigured();
  };

  /**
   * Set remote server configuration
   */
  setRemoteServerConfig = async (config: DataSyncConfig) => {
    return ensureElectronIpc().remoteServer.setRemoteServerConfig(config);
  };

  /**
   * Clear remote server configuration
   */
  clearRemoteServerConfig = async () => {
    return ensureElectronIpc().remoteServer.clearRemoteServerConfig();
  };

  /**
   * Request authorization
   */
  requestAuthorization = async (config: DataSyncConfig) => {
    return ensureElectronIpc().auth.requestAuthorization(config);
  };

  /**
   * Force the platform (organization lookup) flow, e.g. after an invalid organization address
   */
  requestPlatformAuthorization = async (options?: { switchOrganization?: boolean }) => {
    return ensureElectronIpc().auth.requestPlatformAuthorization(options);
  };

  /**
   * Sign out and restart the platform flow in switch mode
   */
  switchOrganization = async () => {
    return ensureElectronIpc().auth.switchOrganization();
  };

  /**
   * Pending confirmation, for windows/panels that mount after it was requested
   */
  getPendingAuthorizationConfirmation = async () => {
    return ensureElectronIpc().auth.getPendingAuthorizationConfirmation();
  };

  /**
   * The renderer only ever sends the confirmation id and generation back.
   */
  confirmAuthorization = async (params: AuthorizationConfirmParams) => {
    return ensureElectronIpc().auth.confirmAuthorization(params);
  };

  cancelAuthorizationConfirmation = async (params: AuthorizationConfirmParams) => {
    return ensureElectronIpc().auth.cancelAuthorizationConfirmation(params);
  };

  switchAuthorizationOrganization = async (params: AuthorizationConfirmParams) => {
    return ensureElectronIpc().auth.switchAuthorizationOrganization(params);
  };

  /**
   * Request Market authorization
   */
  requestMarketAuthorization = async (params: MarketAuthorizationParams) => {
    return ensureElectronIpc().auth.requestMarketAuthorization(params);
  };

  /**
   * Cancel authorization
   */
  cancelAuthorization = async () => {
    return ensureElectronIpc().auth.cancelAuthorization();
  };

  /**
   * Setup subscription webview session with OIDC token injection
   * This configures the webview partition session to inject authentication tokens
   * for requests to the official domain.
   * @param partition The partition name for the webview session
   */
  setupSubscriptionWebviewSession = async (partition: string) => {
    return ensureElectronIpc().remoteServer.setupSubscriptionWebviewSession({ partition });
  };
}

export const remoteServerService = new RemoteServerService();

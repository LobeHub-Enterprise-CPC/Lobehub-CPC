import type {
  AuthorizationConfirmParams,
  AuthorizationConfirmRequest,
  AuthorizationConfirmResult,
  AuthorizationStartResult,
  DataSyncConfig,
  MarketAuthorizationParams,
} from '@lobechat/electron-client-ipc';
import { BrowserWindow, shell } from 'electron';

import { isDev } from '@/const/env';
import { AuthFlowManager } from '@/modules/tenantAuth/AuthFlowManager';
import { createJwksResolver } from '@/modules/tenantAuth/tokenVerifier';
import GatewayConnectionService from '@/services/gatewayConnectionSrv';
import { createLogger } from '@/utils/logger';

import { ControllerModule, IpcMethod } from './index';
import RemoteServerConfigCtr from './RemoteServerConfigCtr';

const logger = createLogger('controllers:AuthCtr');

// Refresh the access token only once it is within this window of its expiry. Kept
// small (minutes) on purpose: a buffer that is large relative to the server's
// access-token lifetime makes the token look "expiring soon" right after login,
// refreshing on every launch/activation and churning refresh-token rotations.
const TOKEN_REFRESH_BUFFER = 10 * 60 * 1000; // 10 minutes

/**
 * Authentication Controller
 * Implements the OAuth authorization flow: organization handoff (platform) or direct tenant
 * OIDC (known entry), polling, token verification and the confirmation before activation.
 * The flow itself lives in `AuthFlowManager`; this controller owns IPC, refresh and gateway.
 */
export default class AuthCtr extends ControllerModule {
  static override readonly groupName = 'auth';
  /**
   * Remote server configuration controller
   */
  private get remoteServerConfigCtr() {
    return this.app.getController(RemoteServerConfigCtr);
  }

  /**
   * Auto-refresh timer
   */

  private autoRefreshTimer: NodeJS.Timeout | null = null;

  private readonly jwks = createJwksResolver({ allowLoopbackHttp: isDev });

  private _flowManager?: AuthFlowManager;

  private get flowManager() {
    this._flowManager ??= new AuthFlowManager({
      afterCommit: () => this.onAuthorizationCommitted(),
      allowLoopbackHttp: isDev,
      broadcast: (channel, payload) => this.broadcast(channel, payload),
      commit: (params) => this.remoteServerConfigCtr.commitAuthorization(params),
      getCommittedTenant: async () =>
        (await this.remoteServerConfigCtr.getRemoteServerConfig()).cloudTenant,
      jwks: this.jwks,
      openExternal: (url) => shell.openExternal(url),
      platformOrigin: () => this.remoteServerConfigCtr.getPlatformOrigin(),
    });
    return this._flowManager;
  }

  /**
   * Request OAuth authorization
   */
  @IpcMethod()
  async requestAuthorization(config: DataSyncConfig): Promise<AuthorizationStartResult> {
    try {
      return await this.flowManager.start(config, {
        // After a 409 on the logged-in session the committed entry is no longer trusted.
        forceDiscovery: this.remoteServerConfigCtr.isRemoteActivityPaused(),
      });
    } catch (error) {
      logger.error('Authorization request failed:', error);
      return {
        code: 'UNKNOWN',
        error: error instanceof Error ? error.message : String(error),
        success: false,
      };
    }
  }

  /**
   * Start the organization lookup page regardless of any known entry
   * (e.g. after a known address turned out not to be an organization address).
   */
  @IpcMethod()
  async requestPlatformAuthorization(
    options: { switchOrganization?: boolean } = {},
  ): Promise<AuthorizationStartResult> {
    try {
      return await this.flowManager.startPlatform({
        switchOrganization: options?.switchOrganization === true,
      });
    } catch (error) {
      logger.error('Platform authorization request failed:', error);
      return {
        code: 'UNKNOWN',
        error: error instanceof Error ? error.message : String(error),
        success: false,
      };
    }
  }

  /**
   * "Switch organization": discard any pending flow and pick again on the platform (fresh
   * state and PKCE, `switch=1`). Nothing of the signed-in session is touched here; its
   * tokens, refresh and gateway are replaced only if the new login is confirmed and committed.
   */
  @IpcMethod()
  async switchOrganization(): Promise<AuthorizationStartResult> {
    try {
      return await this.flowManager.startPlatform({ switchOrganization: true });
    } catch (error) {
      logger.error('Switching organization failed:', error);
      return {
        code: 'UNKNOWN',
        error: error instanceof Error ? error.message : String(error),
        success: false,
      };
    }
  }

  /**
   * Cancel current authorization process
   */
  @IpcMethod()
  async cancelAuthorization() {
    if (this.flowManager.hasActiveFlow()) {
      logger.info('User cancelled authorization');
      this.flowManager.cancel();
      return { success: true };
    }
    return { error: 'No active authorization', success: false };
  }

  /** The confirmation card to show, for windows that mounted after the broadcast. */
  @IpcMethod()
  async getPendingAuthorizationConfirmation(): Promise<AuthorizationConfirmRequest | null> {
    return this.flowManager.getPendingRequest();
  }

  @IpcMethod()
  async confirmAuthorization(
    params: AuthorizationConfirmParams,
  ): Promise<AuthorizationConfirmResult> {
    return this.flowManager.confirm(params);
  }

  @IpcMethod()
  async cancelAuthorizationConfirmation(params: AuthorizationConfirmParams) {
    return this.flowManager.cancelConfirmation(params);
  }

  @IpcMethod()
  async switchAuthorizationOrganization(
    params: AuthorizationConfirmParams,
  ): Promise<AuthorizationStartResult> {
    return this.flowManager.switchFromConfirmation(params);
  }

  /**
   * Request Market OAuth authorization (desktop)
   */
  @IpcMethod()
  async requestMarketAuthorization(params: MarketAuthorizationParams) {
    const { authUrl } = params;

    if (!authUrl) {
      const errorMessage = 'Market authorization URL is required';
      logger.error(errorMessage);
      return { error: errorMessage, success: false };
    }

    logger.info('Requesting market authorization');
    try {
      await shell.openExternal(authUrl);
      logger.debug('Opening market authorization URL in default browser');
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('Market authorization request failed:', error);
      return { error: message, success: false };
    }
  }

  /**
   * After the confirmed login is committed: only now do refresh and the gateway start,
   * and the gateway is reconnected from scratch so no socket keeps the previous identity.
   */
  private onAuthorizationCommitted() {
    this.startAutoRefresh();

    const gatewaySrv = this.app.getService(GatewayConnectionService);
    if (gatewaySrv) {
      logger.info('Triggering gateway connection after login');
      // Canary's `restart()` is the same intent (drop the previous identity's socket,
      // then connect); keep one implementation instead of a local disconnect+connect.
      gatewaySrv.restart().catch((error) => {
        logger.error('Gateway connection after login failed:', error);
      });
    }
  }

  private broadcast(channel: string, payload?: unknown) {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(channel, ...(payload === undefined ? [] : [payload]));
      }
    }
  }

  /**
   * Start auto-refresh timer
   */
  private startAutoRefresh() {
    // Stop existing timer first
    this.stopAutoRefresh();

    const checkInterval = 2 * 60 * 1000; // Check every 2 minutes
    logger.debug('Starting auto-refresh timer');

    this.autoRefreshTimer = setInterval(async () => {
      try {
        if (this.remoteServerConfigCtr.isRemoteActivityPaused()) {
          // A 409 paused this session; nothing is refreshed until the user logs in again.
          this.stopAutoRefresh();
          return;
        }
        if (!this.remoteServerConfigCtr.isTokenExpiringSoon(TOKEN_REFRESH_BUFFER)) {
          return;
        }
        const expiresAt = this.remoteServerConfigCtr.getTokenExpiresAt();
        logger.info(
          `Token is expiring soon, triggering auto-refresh. Expires at: ${expiresAt ? new Date(expiresAt).toISOString() : 'unknown'}`,
        );

        const result = await this.remoteServerConfigCtr.refreshAccessToken();
        if (result.success) {
          logger.info('Auto-refresh successful');
          this.broadcastTokenRefreshed();
        } else {
          logger.error(`Auto-refresh failed after retries: ${result.error}`);

          // Only clear tokens for non-retryable errors (e.g., invalid_grant)
          // The retry mechanism in RemoteServerConfigCtr already handles transient errors
          if (this.remoteServerConfigCtr.isNonRetryableError(result.error)) {
            logger.warn(
              'Non-retryable error detected, clearing tokens and requiring re-authorization',
            );
            this.stopAutoRefresh();
            await this.remoteServerConfigCtr.clearTokens();
            await this.remoteServerConfigCtr.setRemoteServerConfig({ active: false });
            this.broadcastAuthorizationRequired(
              `auto-refresh:non_retryable ${result.error ?? ''}`.trim(),
            );
          } else {
            // For other errors (after retries exhausted), log but don't clear tokens immediately
            // The next refresh cycle will retry
            logger.warn('Refresh failed but error may be transient, will retry on next cycle');
          }
        }
      } catch (error) {
        logger.error('Error during auto-refresh check:', error);
      }
    }, checkInterval);
  }

  /**
   * Stop auto-refresh timer
   */
  private stopAutoRefresh() {
    if (this.autoRefreshTimer) {
      clearInterval(this.autoRefreshTimer);
      this.autoRefreshTimer = null;
      logger.debug('Stopped auto-refresh timer');
    }
  }

  /**
   * Refresh access token
   * This method includes retry mechanism via RemoteServerConfigCtr.refreshAccessToken()
   */
  async refreshAccessToken() {
    logger.info('Starting to refresh access token');
    try {
      // Call the centralized refresh logic in RemoteServerConfigCtr (includes retry)
      const result = await this.remoteServerConfigCtr.refreshAccessToken();

      if (result.success) {
        logger.info('Token refresh successful via AuthCtr call.');
        // Notify render process that token has been refreshed
        this.broadcastTokenRefreshed();
        // Restart auto-refresh timer with new expiration time
        this.startAutoRefresh();
        return { success: true };
      } else {
        logger.error(`Token refresh failed via AuthCtr call: ${result.error}`);

        // Only clear tokens for non-retryable errors (e.g., invalid_grant)
        if (this.remoteServerConfigCtr.isNonRetryableError(result.error)) {
          logger.warn(
            'Non-retryable error detected, clearing tokens and requiring re-authorization',
          );
          this.stopAutoRefresh();
          await this.remoteServerConfigCtr.clearTokens();
          await this.remoteServerConfigCtr.setRemoteServerConfig({ active: false });
          this.broadcastAuthorizationRequired(`refresh:non_retryable ${result.error ?? ''}`.trim());
        } else {
          // For transient errors, don't clear tokens - allow manual retry
          logger.warn('Refresh failed but error may be transient, tokens preserved for retry');
        }

        return { error: result.error, success: false };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Token refresh operation failed via AuthCtr:', errorMessage);

      // Only clear tokens for non-retryable errors
      if (this.remoteServerConfigCtr.isNonRetryableError(errorMessage)) {
        logger.warn('Non-retryable error in catch block, clearing tokens');
        this.stopAutoRefresh();
        await this.remoteServerConfigCtr.clearTokens();
        await this.remoteServerConfigCtr.setRemoteServerConfig({ active: false });
        this.broadcastAuthorizationRequired(`refresh:exception ${errorMessage}`);
      }

      return { error: errorMessage, success: false };
    }
  }

  /**
   * Broadcast token refreshed event
   */
  private broadcastTokenRefreshed() {
    logger.debug('Broadcasting tokenRefreshed event to all windows');
    this.broadcast('tokenRefreshed');
  }

  /**
   * Broadcast authorization required event.
   * `reason` is a short tag (e.g. `refresh:invalid_grant`, `startup:non_retryable`)
   * recorded so the renderer can log why the Session Expired modal appeared.
   */
  private broadcastAuthorizationRequired(reason: string) {
    logger.info(`Broadcasting authorizationRequired event (reason=${reason})`);
    this.broadcast('authorizationRequired', { reason });
  }

  /**
   * Initialize after app is ready
   */
  afterAppReady() {
    logger.debug('AuthCtr initialized, checking for existing tokens');
    // Logging out (from any window) also ends an authorization that is still in flight.
    this.remoteServerConfigCtr.onLogout?.(() => {
      this.flowManager.cancel();
      this.stopAutoRefresh();
    });
    this.initializeAutoRefresh();
  }

  /**
   * Clean up all timers
   */
  cleanup() {
    logger.debug('Cleaning up AuthCtr timers');
    this._flowManager?.dispose();
    this.stopAutoRefresh();
  }

  /**
   * Initialize auto-refresh functionality
   * Checks for valid token at app startup and starts auto-refresh timer if token exists
   * Proactively refreshes the token only when it is expired or near expiry
   */
  private async initializeAutoRefresh() {
    try {
      const config = await this.remoteServerConfigCtr.getRemoteServerConfig();

      // Check if remote server is configured and active
      if (!(await this.remoteServerConfigCtr.isRemoteServerConfigured(config))) {
        logger.debug(
          'Remote server not active or configured, skipping auto-refresh initialization',
        );
        return;
      }

      // Check if valid access token exists
      const accessToken = await this.remoteServerConfigCtr.getAccessToken();
      if (!accessToken) {
        logger.debug('No access token found, skipping auto-refresh initialization');
        return;
      }

      // Check if token expiration time exists
      const expiresAt = this.remoteServerConfigCtr.getTokenExpiresAt();
      if (!expiresAt) {
        logger.debug('No token expiration time found, skipping auto-refresh initialization');
        return;
      }

      // Refresh proactively only when the token is actually near expiry. The access
      // token is long-lived; refreshing on every launch just multiplies refresh-token
      // rotations — and the chance of a lost-response logout — for no benefit.
      if (this.remoteServerConfigCtr.isTokenExpiringSoon(TOKEN_REFRESH_BUFFER)) {
        logger.info('Token is expired or expiring soon, refreshing on startup');
        await this.performProactiveRefresh();
        return;
      }

      // Start auto-refresh timer
      logger.info(
        `Token is valid, starting auto-refresh timer. Token expires at: ${new Date(expiresAt).toISOString()}`,
      );
      this.startAutoRefresh();
    } catch (error) {
      logger.error('Error during auto-refresh initialization:', error);
    }
  }

  /**
   * Perform proactive token refresh (used on startup and app activation)
   */
  private async performProactiveRefresh(): Promise<void> {
    const refreshResult = await this.remoteServerConfigCtr.refreshAccessToken();
    if (refreshResult.success) {
      logger.info('Proactive token refresh successful');
      this.broadcastTokenRefreshed();
      this.startAutoRefresh();
    } else {
      logger.error(`Proactive token refresh failed: ${refreshResult.error}`);

      // Only clear token for non-retryable errors
      if (this.remoteServerConfigCtr.isNonRetryableError(refreshResult.error)) {
        logger.warn('Non-retryable error during proactive refresh, clearing tokens');
        await this.remoteServerConfigCtr.clearTokens();
        await this.remoteServerConfigCtr.setRemoteServerConfig({ active: false });
        this.broadcastAuthorizationRequired(
          `startup:non_retryable ${refreshResult.error ?? ''}`.trim(),
        );
      } else {
        // For transient errors, still start auto-refresh timer to retry later
        logger.warn('Transient error during proactive refresh, will retry via auto-refresh');
        this.startAutoRefresh();
      }
    }
  }

  /**
   * Handle app activation event (e.g., Mac dock click, window focus)
   * Proactively refresh token if it is expired or near expiry
   */
  async onAppActivate(): Promise<void> {
    logger.debug('App activated, checking if token refresh is needed');

    try {
      const config = await this.remoteServerConfigCtr.getRemoteServerConfig();

      // Check if remote server is configured and active
      if (!(await this.remoteServerConfigCtr.isRemoteServerConfigured(config))) {
        logger.debug('Remote server not active, skipping activation refresh');
        return;
      }

      // Check if valid access token exists
      const accessToken = await this.remoteServerConfigCtr.getAccessToken();
      if (!accessToken) {
        logger.debug('No access token found, skipping activation refresh');
        return;
      }

      // Refresh only when the token is actually near expiry (see initializeAutoRefresh).
      if (this.remoteServerConfigCtr.isTokenExpiringSoon(TOKEN_REFRESH_BUFFER)) {
        logger.info('Token is expiring soon on app activation, refreshing token');
        await this.performProactiveRefresh();
      } else {
        logger.debug('Token is still valid, skipping activation refresh');
      }
    } catch (error) {
      logger.error('Error during app activation refresh check:', error);
    }
  }
}

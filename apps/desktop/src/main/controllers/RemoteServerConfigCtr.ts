import querystring from 'node:querystring';
import { URL } from 'node:url';

import type {
  CloudTenant,
  DataSyncConfig,
  DesktopBootstrapIdentity,
  StorageMode,
  TenantEndpointChangedKind,
} from '@lobechat/electron-client-ipc';
import { buildRemoteUrl, normalizeRemoteBaseUrl } from '@lobechat/utils/remoteUrl';
import { safeStorage, session as electronSession } from 'electron';

import { isDev, OFFICIAL_CLOUD_SERVER } from '@/const/env';
import { isSameHost, normalizeEntryUrl } from '@/modules/tenantAuth/entry';
import { isEndpointChangedResponse } from '@/modules/tenantAuth/flowRequests';
import { fetchNoRedirect } from '@/modules/tenantAuth/safeFetch';
import GatewayConnectionService from '@/services/gatewayConnectionSrv';
import { appendVercelCookie } from '@/utils/http-headers';
import { createLogger } from '@/utils/logger';
import { setDesktopUserAgentHeader } from '@/utils/user-agent';

import { ControllerModule, IpcMethod } from './index';

/**
 * Non-retryable OIDC error codes
 * These errors indicate the refresh token is invalid and retry won't help
 */
const NON_RETRYABLE_OIDC_ERRORS = [
  'invalid_grant', // refresh token is invalid, expired, or revoked
  'invalid_client', // client configuration error
  'unauthorized_client', // client not authorized
  'access_denied', // user denied access
  'invalid_scope', // requested scope is invalid
];

/**
 * Deterministic failures that will never succeed on retry
 * These are permanent state issues that require user intervention
 */
const DETERMINISTIC_FAILURES = [
  'no refresh token available', // refresh token is missing from storage
  'remote server is not active or configured', // config is invalid or disabled
  'missing tokens in refresh response', // server returned incomplete response
];

// Create logger
const logger = createLogger('controllers:RemoteServerConfigCtr');

/** Whether the build's official cloud is lobehub.com itself (or a subdomain of it). */
const isLobehubOfficialServer = (server: string | undefined): boolean => {
  try {
    const hostname = new URL(server ?? '').hostname.toLowerCase();
    return hostname === 'lobehub.com' || hostname.endsWith('.lobehub.com');
  } catch {
    return false;
  }
};

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;

/** Structural check for a persisted `cloudTenant`; anything else is treated as not logged in. */
const isValidCloudTenant = (value: unknown): value is CloudTenant => {
  if (typeof value !== 'object' || value === null) return false;
  const { display, entryUrl, generation, identity } = value as Partial<CloudTenant>;

  return (
    isNonEmptyString(entryUrl) &&
    normalizeEntryUrl(entryUrl, isDev) === entryUrl &&
    isNonEmptyString(generation) &&
    typeof identity === 'object' &&
    identity !== null &&
    isNonEmptyString(identity.issuer) &&
    isNonEmptyString(identity.subject) &&
    isNonEmptyString(identity.tenantId) &&
    typeof display === 'object' &&
    display !== null &&
    isNonEmptyString(display.account) &&
    (display.organizationName === undefined || typeof display.organizationName === 'string') &&
    (display.organizationSlug === undefined || typeof display.organizationSlug === 'string') &&
    (display.hasOtherOrganizations === undefined ||
      typeof display.hasOtherOrganizations === 'boolean')
  );
};

export interface CommitAuthorizationParams {
  display: CloudTenant['display'];
  entryUrl: string;
  generation: string;
  identity: CloudTenant['identity'];
  /** Typed server address, kept for self-hosted configs. */
  remoteServerUrl?: string;
  storageMode: StorageMode;
  tokens: { accessToken: string; expiresIn?: number; refreshToken: string };
}

/**
 * Remote Server Configuration Controller
 * Used to manage custom remote LobeChat server configuration
 */
export default class RemoteServerConfigCtr extends ControllerModule {
  static override readonly groupName = 'remoteServer';
  /**
   * Key used to store encrypted tokens in electron-store.
   */
  private readonly encryptedTokensKey = 'encryptedTokens';

  /**
   * Normalize legacy config that used local storageMode.
   * Local mode has been removed; fall back to cloud.
   */
  private normalizeConfig = (rawConfig: DataSyncConfig): DataSyncConfig => {
    // The remote URL is a tenant address that may carry a path prefix (`https://host/t/acme`):
    // keep the prefix, drop trailing slashes / query / hash so every `${url}/path` join is exact.
    const remoteServerUrl = normalizeRemoteBaseUrl(rawConfig.remoteServerUrl);
    const config =
      remoteServerUrl === rawConfig.remoteServerUrl ? rawConfig : { ...rawConfig, remoteServerUrl };

    // Use type assertion to handle legacy 'local' value from stored data
    if ((config.storageMode as string) !== 'local') return config;

    const nextConfig: DataSyncConfig = {
      ...config,
      remoteServerUrl: config.remoteServerUrl || normalizeRemoteBaseUrl(OFFICIAL_CLOUD_SERVER),
      storageMode: 'cloud',
    };

    this.app.storeManager.set('dataSyncConfig', nextConfig);

    return nextConfig;
  };

  /**
   * Get remote server configuration
   */
  @IpcMethod()
  async getRemoteServerConfig() {
    logger.debug('Getting remote server configuration');
    const { storeManager } = this.app;

    this.reconcileStoredState();
    const config: DataSyncConfig = storeManager.get('dataSyncConfig');
    const normalized = this.normalizeConfig(config);

    logger.debug(
      `Remote server config: active=${normalized.active}, storageMode=${normalized.storageMode}, url=${normalized.remoteServerUrl}`,
    );

    return normalized;
  }

  /**
   * Check if remote server is properly configured and ready for use
   * For 'cloud' mode, checks if active AND a confirmed tenant entry (`cloudTenant`) is committed;
   * the platform origin is never used as a fallback for business requests.
   * For 'selfHost' mode, checks if active AND remoteServerUrl is configured
   * @param config Optional config object, if not provided will fetch current config
   * @returns true if remote server is properly configured
   */
  @IpcMethod()
  async isRemoteServerConfigured(config?: DataSyncConfig): Promise<boolean> {
    const effectiveConfig = config ?? (await this.getRemoteServerConfig());
    const isActive = Boolean(effectiveConfig.active);
    const isSelfHostConfigured =
      effectiveConfig.storageMode !== 'selfHost' ||
      this.isValidSelfHostRemoteUrl(effectiveConfig.remoteServerUrl);
    const isCloudConfigured =
      effectiveConfig.storageMode !== 'cloud' || isValidCloudTenant(effectiveConfig.cloudTenant);

    return isActive && isSelfHostConfigured && isCloudConfigured;
  }

  private isValidSelfHostRemoteUrl(remoteServerUrl?: string): boolean {
    if (!remoteServerUrl) return false;
    const normalizedUrl = remoteServerUrl.trim();

    if (!normalizedUrl) return false;

    try {
      const parsedUrl = new URL(normalizedUrl);
      return parsedUrl.protocol === 'http:' || parsedUrl.protocol === 'https:';
    } catch {
      return false;
    }
  }

  /**
   * Set remote server configuration
   */
  @IpcMethod()
  async setRemoteServerConfig(config: Partial<DataSyncConfig>) {
    logger.info(
      `Setting remote server storageMode: active=${config.active}, storageMode=${config.storageMode}, url=${config.remoteServerUrl}`,
    );
    const { storeManager } = this.app;
    this.reconcileStoredState();
    const prev: DataSyncConfig = storeManager.get('dataSyncConfig');

    // `cloudTenant` is committed by the main process together with the tokens; a caller
    // (the renderer in particular) can neither set nor replace it.
    const { cloudTenant: _ignoredCloudTenant, ...requested } = config;

    // Save configuration with legacy local storage fallback
    const merged = this.normalizeConfig({ ...prev, ...requested });
    storeManager.set('dataSyncConfig', merged);

    this.broadcastRemoteServerConfigUpdated();

    return true;
  }

  /**
   * Clear remote server configuration
   */
  @IpcMethod()
  async clearRemoteServerConfig() {
    logger.info('Clearing remote server configuration');
    const { storeManager } = this.app;

    // Clear instance configuration (including the confirmed tenant record)
    storeManager.set('dataSyncConfig', { active: false, storageMode: 'cloud' });
    this.endpointChangedPaused = false;

    // Stop any authorization still in flight before its pending credentials can be committed
    for (const listener of this.logoutListeners) listener();

    // Clear tokens (if any)
    await this.clearTokens();

    this.broadcastRemoteServerConfigUpdated();

    return true;
  }

  private readonly logoutListeners = new Set<() => void>();

  /** Called when the user logs out, so in-flight authorizations are cancelled too. */
  onLogout(listener: () => void) {
    this.logoutListeners.add(listener);
  }

  private broadcastRemoteServerConfigUpdated() {
    logger.debug('Broadcasting remoteServerConfigUpdated event to all windows');
    this.app.browserManager.broadcastToAllWindows('remoteServerConfigUpdated', undefined);
  }

  /**
   * Encrypted tokens
   * Stored in memory for quick access, loaded from persistent storage on init.
   */
  private encryptedAccessToken?: string;
  private encryptedRefreshToken?: string;

  /**
   * Token expiration time (timestamp in milliseconds)
   * Used for automatic token refresh
   */
  private tokenExpiresAt?: number;

  /**
   * Last token refresh time (timestamp in milliseconds)
   * Used to control refresh frequency on app startup/activate
   */
  private lastRefreshAt?: number;

  /**
   * Resolve the cache-partition identity synchronously for the renderer preload.
   * This deliberately avoids `getUserState()`: the encrypted OIDC token already
   * contains the stable subject required for local isolation.
   */
  getDesktopBootstrapIdentity(): DesktopBootstrapIdentity {
    if (!this.encryptedAccessToken) this.loadTokensFromStore();

    if (!this.encryptedAccessToken) return { isIdentityResolved: true };

    try {
      const accessToken = safeStorage.isEncryptionAvailable()
        ? safeStorage.decryptString(Buffer.from(this.encryptedAccessToken, 'base64'))
        : this.encryptedAccessToken;
      const parts = accessToken.split('.');
      if (parts.length !== 3) return { isIdentityResolved: false };

      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as {
        sub?: unknown;
      };
      if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
        return { isIdentityResolved: false };
      }

      return { isIdentityResolved: true, userId: payload.sub };
    } catch (error) {
      logger.warn('Failed to resolve Desktop bootstrap identity from access token:', error);
      return { isIdentityResolved: false };
    }
  }

  /**
   * Promise representing the ongoing token refresh operation.
   * Used to prevent concurrent refreshes and allow callers to wait.
   */
  private refreshPromise: Promise<{ error?: string; success: boolean }> | null = null;

  /**
   * Generation of the authorization these tokens were committed with. Set together with
   * `cloudTenant.generation`; undefined only for legacy self-hosted sessions.
   */
  private tokenGeneration?: string;

  /** Bumped whenever the active session is replaced or cleared, to discard stale responses. */
  private sessionEpoch = 0;

  /** Set once a 409 TENANT_ENDPOINT_CHANGED arrives on a logged-in session. */
  private endpointChangedPaused = false;

  private reconciled = false;

  private protectToken(value: string): string {
    if (!safeStorage.isEncryptionAvailable()) {
      logger.warn('Safe storage not available, storing tokens unencrypted');
      return value;
    }
    return Buffer.from(safeStorage.encryptString(value)).toString('base64');
  }

  private buildEncryptedTokens(
    accessToken: string,
    refreshToken: string,
    expiresIn: number | undefined,
    generation: string | undefined,
  ) {
    const now = Date.now();
    return {
      accessToken: this.protectToken(accessToken),
      expiresAt: expiresIn ? now + expiresIn * 1000 : undefined,
      generation,
      lastRefreshAt: now,
      refreshToken: this.protectToken(refreshToken),
    };
  }

  private applyTokensToMemory(tokens: {
    accessToken: string;
    expiresAt?: number;
    generation?: string;
    lastRefreshAt?: number;
    refreshToken: string;
  }) {
    this.encryptedAccessToken = tokens.accessToken;
    this.encryptedRefreshToken = tokens.refreshToken;
    this.tokenExpiresAt = tokens.expiresAt;
    this.lastRefreshAt = tokens.lastRefreshAt;
    this.tokenGeneration = tokens.generation;
  }

  /**
   * Encrypt and store refreshed tokens for the already committed session. The generation
   * stays that of the session, so a refresh can never re-label tokens as another login.
   * @param accessToken Access token
   * @param refreshToken Refresh token
   * @param expiresIn Token expiration time in seconds (optional)
   */
  async saveTokens(accessToken: string, refreshToken: string, expiresIn?: number) {
    logger.info('Saving encrypted tokens');

    const tokens = this.buildEncryptedTokens(
      accessToken,
      refreshToken,
      expiresIn,
      this.tokenGeneration,
    );
    this.app.storeManager.set(this.encryptedTokensKey, tokens);
    this.applyTokensToMemory(tokens);

    if (tokens.expiresAt) {
      logger.debug(`Token expires at: ${new Date(tokens.expiresAt).toISOString()}`);
    }

    this.syncGatewayAccessToken(accessToken);
  }

  /**
   * Commit a confirmed authorization: tokens, `cloudTenant` and `active` land in one store
   * write (all or nothing), then memory is updated. Nothing here touches the gateway; the
   * caller reconnects it only after this resolves. Everything before the write is
   * synchronous, so a caller's generation check immediately before the call still holds.
   */
  async commitAuthorization(params: CommitAuthorizationParams): Promise<void> {
    const { storeManager } = this.app;
    this.reconcileStoredState();
    const prev: DataSyncConfig = storeManager.get('dataSyncConfig');

    // A re-login of the very same identity (e.g. through a known entry, which never learns
    // the organization name) keeps the display values confirmed earlier instead of blanking
    // them. Any other identity starts without them: absent means unknown.
    const previousTenant = isValidCloudTenant(prev.cloudTenant) ? prev.cloudTenant : undefined;
    const sameIdentity =
      previousTenant !== undefined &&
      previousTenant.entryUrl === params.entryUrl &&
      previousTenant.identity.issuer === params.identity.issuer &&
      previousTenant.identity.tenantId === params.identity.tenantId &&
      previousTenant.identity.subject === params.identity.subject;
    const kept = sameIdentity ? previousTenant.display : undefined;
    const organizationName = params.display.organizationName || kept?.organizationName;
    const organizationSlug = params.display.organizationSlug || kept?.organizationSlug;
    const hasOtherOrganizations =
      params.display.hasOtherOrganizations ?? kept?.hasOtherOrganizations;

    const cloudTenant: CloudTenant = {
      display: {
        account: params.display.account,
        ...(organizationName ? { organizationName } : {}),
        ...(organizationSlug ? { organizationSlug } : {}),
        ...(hasOtherOrganizations !== undefined ? { hasOtherOrganizations } : {}),
      },
      entryUrl: params.entryUrl,
      generation: params.generation,
      identity: params.identity,
    };

    const { remoteServerUrl: _previousUrl, ...rest } = prev;
    const nextConfig = this.normalizeConfig({
      ...rest,
      active: true,
      cloudTenant,
      ...(params.storageMode === 'selfHost'
        ? { remoteServerUrl: params.remoteServerUrl ?? params.entryUrl }
        : {}),
      storageMode: params.storageMode,
    });

    const tokens = this.buildEncryptedTokens(
      params.tokens.accessToken,
      params.tokens.refreshToken,
      params.tokens.expiresIn,
      params.generation,
    );

    // One atomic write: config and tokens carry the same generation or neither is stored.
    storeManager.setMany({ dataSyncConfig: nextConfig, encryptedTokens: tokens });

    this.applyTokensToMemory(tokens);
    this.sessionEpoch += 1;
    this.endpointChangedPaused = false;
    logger.info('Committed authorization');

    this.broadcastRemoteServerConfigUpdated();
  }

  /**
   * Hand a freshly stored access token to the live device-gateway socket.
   *
   * The gateway client caches the token it was constructed with and replays it
   * on every backoff / heartbeat reconnect, while the token itself is rotated
   * here (AuthCtr's auto-refresh timer). Without this push the refresh only
   * became visible after the connection had already been torn down and rejected
   * — the socket dropped, the client replayed the stale token, and `auth_failed`
   * left the device offline.
   */
  private syncGatewayAccessToken(accessToken: string) {
    this.app.getService(GatewayConnectionService)?.updatePersonalToken(accessToken);
  }

  /**
   * Get decrypted access token
   */
  async getAccessToken(): Promise<string | null> {
    // Try loading from memory first
    if (!this.encryptedAccessToken) {
      logger.debug('Access token not in memory, trying to load from store...');
      this.loadTokensFromStore(); // Attempt to load from persistent storage
    }

    if (!this.encryptedAccessToken) {
      logger.debug('No access token found in memory or store.');
      return null;
    }

    // If platform doesn't support secure storage, return stored token
    if (!safeStorage.isEncryptionAvailable()) {
      logger.debug(
        'Safe storage not available, returning potentially unencrypted token from memory/store',
      );
      return this.encryptedAccessToken;
    }

    try {
      // Decrypt token
      logger.debug('Decrypting access token');
      const encryptedData = Buffer.from(this.encryptedAccessToken, 'base64');
      return safeStorage.decryptString(encryptedData);
    } catch (error) {
      logger.error('Failed to decrypt access token:', error);
      return null;
    }
  }

  /**
   * Get decrypted refresh token
   */
  async getRefreshToken(): Promise<string | null> {
    // Try loading from memory first
    if (!this.encryptedRefreshToken) {
      logger.debug('Refresh token not in memory, trying to load from store...');
      this.loadTokensFromStore(); // Attempt to load from persistent storage
    }

    if (!this.encryptedRefreshToken) {
      logger.debug('No refresh token found in memory or store.');
      return null;
    }

    // If platform doesn't support secure storage, return stored token
    if (!safeStorage.isEncryptionAvailable()) {
      logger.debug(
        'Safe storage not available, returning potentially unencrypted token from memory/store',
      );
      return this.encryptedRefreshToken;
    }

    try {
      // Decrypt token
      logger.debug('Decrypting refresh token');
      const encryptedData = Buffer.from(this.encryptedRefreshToken, 'base64');
      return safeStorage.decryptString(encryptedData);
    } catch (error) {
      logger.error('Failed to decrypt refresh token:', error);
      return null;
    }
  }

  /**
   * Clear tokens
   */
  async clearTokens() {
    logger.info('Clearing access and refresh tokens');
    this.encryptedAccessToken = undefined;
    this.encryptedRefreshToken = undefined;
    this.tokenExpiresAt = undefined;
    this.tokenGeneration = undefined;
    this.sessionEpoch += 1;
    // Also clear from persistent storage
    logger.debug(`Deleting tokens from store key: ${this.encryptedTokensKey}`);
    this.app.storeManager.delete(this.encryptedTokensKey);

    // Disconnect gateway when tokens are cleared (logout / token refresh failure)
    const gatewaySrv = this.app.getService(GatewayConnectionService);
    if (gatewaySrv) {
      logger.debug('Disconnecting gateway due to token clear');
      await gatewaySrv.disconnect();
    }
  }

  /**
   * Get token expiration time
   */
  getTokenExpiresAt(): number | undefined {
    return this.tokenExpiresAt;
  }

  /**
   * Check if token is expired or will expire soon
   * @param bufferTimeMs Buffer time in milliseconds (default 1 day)
   * @returns true if token is expired or will expire soon
   */
  isTokenExpiringSoon(bufferTimeMs: number = 24 * 60 * 60 * 1000): boolean {
    if (!this.tokenExpiresAt) {
      return false; // No expiration time available
    }

    const currentTime = Date.now();
    const bufferTime = this.tokenExpiresAt - bufferTimeMs;

    return currentTime >= bufferTime;
  }

  /**
   * Check if an error is non-retryable
   * Includes OIDC errors (e.g., invalid_grant) and deterministic failures
   * (e.g., missing refresh token, invalid config)
   * @param error Error message to check
   * @returns true if the error should not be retried
   */
  isNonRetryableError(error?: string): boolean {
    if (!error) return false;
    const lowerError = error.toLowerCase();

    // Check OIDC error codes
    if (NON_RETRYABLE_OIDC_ERRORS.some((code) => lowerError.includes(code))) {
      return true;
    }

    // Check deterministic failures that require user intervention
    if (DETERMINISTIC_FAILURES.some((msg) => lowerError.includes(msg))) {
      return true;
    }

    return false;
  }

  /**
   * Refresh the access token using the stored refresh token (single attempt).
   * Concurrent callers share the in-progress refresh promise.
   */
  async refreshAccessToken(): Promise<{ error?: string; success: boolean }> {
    // If a refresh is already in progress, return the existing promise
    if (this.refreshPromise) {
      logger.debug('Token refresh already in progress, returning existing promise.');
      return this.refreshPromise;
    }

    logger.info('Initiating new token refresh operation.');

    // No retry: with refresh token rotation the server consumes the old token as soon
    // as the request lands. Resending it (e.g. after a lost response) triggers reuse
    // detection — invalid_grant + revocation of the whole grant — which logs the user
    // out. Transient failures are recovered by the next refresh cycle instead.
    this.refreshPromise = this.performTokenRefresh().finally(() => {
      logger.debug('Clearing the refresh promise reference.');
      this.refreshPromise = null;
    });

    return this.refreshPromise;
  }

  /**
   * Performs the actual token refresh logic.
   * This method is called by refreshAccessToken and wrapped in a promise.
   */
  private async performTokenRefresh(): Promise<{ error?: string; success: boolean }> {
    try {
      if (this.endpointChangedPaused) {
        return { error: 'Remote activity paused: tenant endpoint changed', success: false };
      }

      // Get configuration information
      const config = await this.getRemoteServerConfig();

      if (!(await this.isRemoteServerConfigured(config))) {
        logger.warn('Remote server not active or configured, skipping refresh.');
        return { error: 'Remote server is not active or configured', success: false };
      }

      // Get refresh token
      const refreshToken = await this.getRefreshToken();
      if (!refreshToken) {
        logger.error('No refresh token available for refresh operation.');
        return { error: 'No refresh token available', success: false };
      }

      // The refresh token only ever goes to the entry it was issued by; the response is
      // applied only if the same session is still current when it arrives.
      const epoch = this.sessionEpoch;

      // Construct refresh request (the remote URL may carry a tenant path prefix)
      const remoteUrl = await this.getRemoteServerUrl(config);
      if (!remoteUrl) {
        return { error: 'Remote server is not active or configured', success: false };
      }

      const tokenUrl = buildRemoteUrl('/oidc/token', remoteUrl);

      // Construct request body
      const body = querystring.stringify({
        client_id: 'lobehub-desktop',
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      });

      logger.debug(`Sending token refresh request to ${tokenUrl.origin}`);

      // Send request
      const headers: Record<string, string> = {
        'Content-Type': 'application/x-www-form-urlencoded',
      };
      appendVercelCookie(headers);
      setDesktopUserAgentHeader(headers);
      const response = await fetchNoRedirect(tokenUrl.toString(), {
        body,
        headers,
        method: 'POST',
      });

      if (epoch !== this.sessionEpoch) {
        logger.warn('Session changed during token refresh, discarding the response.');
        await response.body?.cancel().catch(() => undefined);
        return { error: 'Authorization changed during refresh', success: false };
      }

      if (response.status === 409 && (await isEndpointChangedResponse(response.clone()))) {
        // 409 only says "resolve the entry again"; the token is never sent anywhere else.
        this.handleEndpointChanged();
        return { error: 'Tenant endpoint changed', success: false };
      }

      if (!response.ok) {
        // Try to parse error response
        const errorData = await response.json().catch(() => ({}));
        // Keep the OIDC code so AuthCtr can distinguish revoked grants from transient failures.
        const errorDetail = [errorData.error, errorData.error_description]
          .filter(Boolean)
          .join(' ');
        const errorMessage =
          `Token refresh failed: ${response.status} ${response.statusText} ${errorDetail}`.trim();
        logger.error(errorMessage);
        return { error: errorMessage, success: false };
      }

      // Parse response
      const data = await response.json();

      if (epoch !== this.sessionEpoch) {
        logger.warn('Session changed during token refresh, discarding the response.');
        return { error: 'Authorization changed during refresh', success: false };
      }

      // Check if response contains necessary tokens
      if (!data.access_token || !data.refresh_token) {
        logger.error('Refresh response missing access_token or refresh_token');
        return { error: 'Missing tokens in refresh response', success: false };
      }

      // Save new tokens
      logger.info('Token refresh successful, saving new tokens.');
      await this.saveTokens(data.access_token, data.refresh_token, data.expires_in);

      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Exception during token refresh operation:', errorMessage);
      return { error: `Exception occurred during token refresh: ${errorMessage}`, success: false };
    }
  }

  /**
   * The server answered 409 TENANT_ENDPOINT_CHANGED on a logged-in session. That only means
   * the entry has to be resolved again: pause refresh and the gateway, and ask the user to
   * log in again. No credential is ever sent to an address taken from the 409.
   */
  handleEndpointChanged() {
    if (this.endpointChangedPaused) return;

    const config: DataSyncConfig = this.app.storeManager.get('dataSyncConfig');
    if (!config?.active) return;

    this.endpointChangedPaused = true;
    logger.warn('Tenant endpoint changed on a logged-in session, pausing remote activity');

    const entry = config.cloudTenant?.entryUrl ?? config.remoteServerUrl;
    const standalone =
      config.storageMode === 'selfHost' && !(entry && isSameHost(entry, this.getPlatformOrigin()));
    const kind: TenantEndpointChangedKind = standalone
      ? 'update_address_required'
      : 'relogin_required';

    this.app
      .getService(GatewayConnectionService)
      ?.disconnect()
      ?.catch(() => undefined);

    this.app.browserManager.broadcastToAllWindows('tenantEndpointChanged', { kind });
    this.app.browserManager.broadcastToAllWindows('authorizationRequired', {
      reason: 'tenant_endpoint_changed',
    });
  }

  /** Whether remote activity is paused until the user logs in again. */
  isRemoteActivityPaused() {
    return this.endpointChangedPaused;
  }

  /**
   * Make the persisted state self-consistent before anything reads it. Tokens and
   * `cloudTenant` must carry the same generation; otherwise (crash between writes, an
   * older client, hand-edited store) the user is simply logged out.
   */
  private reconcileStoredState() {
    if (this.reconciled) return;
    this.reconciled = true;

    const { storeManager } = this.app;
    const config: DataSyncConfig = storeManager.get('dataSyncConfig') ?? { storageMode: 'cloud' };
    const tokens = storeManager.get(this.encryptedTokensKey) ?? {};
    const hasTokens = Boolean(tokens.accessToken && tokens.refreshToken);
    const tenant = config.cloudTenant;

    let dropTenant = false;
    let dropTokens = false;

    if (tenant !== undefined && !isValidCloudTenant(tenant)) {
      dropTenant = true;
      dropTokens = true;
    } else if (tenant) {
      if (hasTokens && tokens.generation !== tenant.generation) {
        dropTenant = true;
        dropTokens = true;
      }
    } else if (config.storageMode === 'cloud') {
      // Cloud logins from before the confirmed tenant record cannot be trusted.
      dropTokens = hasTokens;
    } else if (tokens.generation) {
      dropTokens = true;
    }

    const wasActive = Boolean(config.active);
    const needsInactive =
      wasActive &&
      (dropTenant ||
        dropTokens ||
        (tenant && !hasTokens) ||
        (!tenant && config.storageMode === 'cloud'));

    if (!dropTenant && !dropTokens && !needsInactive) return;

    logger.warn(
      `Stored authorization is inconsistent, logging out (tenant=${Boolean(tenant)}, tokens=${hasTokens})`,
    );

    const { cloudTenant: _tenant, ...configWithoutTenant } = config;
    storeManager.set('dataSyncConfig', {
      ...(dropTenant ? configWithoutTenant : config),
      active: needsInactive ? false : config.active,
    });
    if (dropTokens) storeManager.delete(this.encryptedTokensKey);
  }

  /**
   * Load encrypted tokens from persistent storage (electron-store) into memory.
   * This should be called during initialization or if memory tokens are missing.
   */
  private loadTokensFromStore() {
    this.reconcileStoredState();
    logger.debug(`Attempting to load tokens from store key: ${this.encryptedTokensKey}`);
    const storedTokens = this.app.storeManager.get(this.encryptedTokensKey);

    if (storedTokens && storedTokens.accessToken && storedTokens.refreshToken) {
      logger.info('Successfully loaded tokens from store into memory.');
      this.encryptedAccessToken = storedTokens.accessToken;
      this.encryptedRefreshToken = storedTokens.refreshToken;
      this.tokenExpiresAt = storedTokens.expiresAt;
      this.lastRefreshAt = storedTokens.lastRefreshAt;
      this.tokenGeneration = storedTokens.generation;

      if (this.tokenExpiresAt) {
        logger.debug(
          `Loaded token expiration time: ${new Date(this.tokenExpiresAt).toISOString()}`,
        );
      }
      if (this.lastRefreshAt) {
        logger.debug(`Loaded last refresh time: ${new Date(this.lastRefreshAt).toISOString()}`);
      }
    } else {
      logger.debug('No valid tokens found in store.');
    }
  }

  /**
   * Get the last token refresh time
   * @returns The timestamp (in milliseconds) of the last token refresh, or undefined if never refreshed
   */
  getLastTokenRefreshAt(): number | undefined {
    return this.lastRefreshAt;
  }

  // Initialize by loading tokens from store when the controller is ready
  // We might need a dedicated lifecycle method if constructor is too early for storeManager
  afterAppReady() {
    this.loadTokensFromStore();
  }

  /** Origin of the platform that hosts the organization lookup page. */
  getPlatformOrigin(): string {
    return normalizeRemoteBaseUrl(OFFICIAL_CLOUD_SERVER);
  }

  /**
   * The confirmed tenant entry business requests go to. A cloud session without a
   * committed `cloudTenant` has none: the platform origin is never a fallback.
   */
  async getRemoteServerUrl(config?: DataSyncConfig): Promise<string | undefined> {
    const dataConfig = this.normalizeConfig(config ?? (await this.getRemoteServerConfig()));

    if (dataConfig.cloudTenant?.entryUrl) return dataConfig.cloudTenant.entryUrl;

    return dataConfig.storageMode === 'selfHost' ? dataConfig.remoteServerUrl : undefined;
  }

  /**
   * Setup subscription webview session with OIDC token injection
   * This configures a webRequest interceptor on the given partition session
   * to automatically inject the Oidc-Auth token header for official domain requests.
   * @param params.partition The partition name for the webview session
   */
  @IpcMethod()
  async setupSubscriptionWebviewSession(params: { partition: string }) {
    const { partition } = params;

    // The token goes to `*.lobehub.com` only for builds whose official cloud is lobehub.com;
    // enterprise builds (and any other host) never register this interceptor.
    if (!isLobehubOfficialServer(OFFICIAL_CLOUD_SERVER)) {
      logger.info('Official cloud is not lobehub.com, skipping Oidc-Auth injection');
      return { skipped: true, success: true };
    }

    logger.info(`Setting up subscription webview session for partition: ${partition}`);

    const session = electronSession.fromPartition(partition);

    session.webRequest.onBeforeSendHeaders(
      { urls: [`https://lobehub.com/*`, `https://*.lobehub.com/*`] },
      async (details, callback) => {
        const requestHeaders = { ...details.requestHeaders };

        const token = await this.getAccessToken();

        if (token) {
          requestHeaders['Oidc-Auth'] = token;
          logger.debug(`Injected Oidc-Auth token for: ${details.url}`);
        }
        setDesktopUserAgentHeader(requestHeaders);

        callback({ requestHeaders });
      },
    );

    logger.debug(`Subscription webview session setup completed for partition: ${partition}`);

    return { success: true };
  }
}

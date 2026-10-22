import crypto from 'node:crypto';
import querystring from 'node:querystring';

import type {
  AuthorizationConfirmDismissReason,
  AuthorizationConfirmParams,
  AuthorizationConfirmRequest,
  AuthorizationConfirmResult,
  AuthorizationErrorCode,
  AuthorizationPhase,
  AuthorizationStartResult,
  CloudTenant,
  CloudTenantDisplay,
  CloudTenantIdentity,
  DataSyncConfig,
  StorageMode,
} from '@lobechat/electron-client-ipc';
import { buildRemoteUrl } from '@lobechat/utils/remoteUrl';

import { appendVercelCookie } from '@/utils/http-headers';
import { createLogger } from '@/utils/logger';
import { setDesktopUserAgentHeader } from '@/utils/user-agent';

import { buildExpectedIssuer, classifyEntry, isSameHost, normalizeEntryUrl } from './entry';
import {
  isEndpointChangedResponse,
  type PlatformSnapshot,
  pollTenantHandoff,
  preflightEntry,
  requestDesktopHandoff,
} from './flowRequests';
import { fetchNoRedirect, readJsonLimited } from './safeFetch';
import {
  DESKTOP_CLIENT_ID,
  type JwksResolver,
  pickAccountDisplay,
  readTenantDisplayClaims,
  readTenantId,
  verifyAccessToken,
  verifyIdToken,
} from './tokenVerifier';

const logger = createLogger('modules:tenantAuth:AuthFlowManager');

/** Platform stage: the user may take a while to pick an organization. */
export const PLATFORM_MAX_WAIT_MS = 10 * 60 * 1000;
/** Tenant stage: waiting for the login/consent in the organization's own pages. */
export const MAX_POLL_TIME = 2 * 60 * 1000;
export const POLL_INTERVAL = 3000;
export const CONFIRMATION_TIMEOUT_MS = 5 * 60 * 1000;
export const MAX_TRANSIENT_FAILURES = 5;
export const MAX_AUTO_RESTARTS = 2;
const BACKOFF_CAP_MS = 30_000;
const MAX_TOKEN_RESPONSE_BYTES = 64 * 1024;

export const AUTH_SCOPE = 'openid profile email offline_access';
const RESOURCE = 'urn:lobehub:chat';

type FlowKind = 'known-entry' | 'platform';

interface Tokens {
  accessToken: string;
  expiresIn?: number;
  refreshToken: string;
}

/** The immutable thing a confirmation card is about. */
interface PendingConfirmation {
  readonly confirmationId: string;
  readonly display: CloudTenantDisplay;
  readonly entryUrl: string;
  readonly expiresAt: number;
  readonly generation: string;
  readonly identity: CloudTenantIdentity;
  readonly tokens: Tokens;
}

interface Flow {
  cancelSleep?: () => void;
  codeChallenge: string;
  codeVerifier: string;
  /** Resolved entry once bound: the only place credentials may go. */
  entry?: string;
  expectedIssuer?: string;
  expectedTenantId?: string;
  generation: string;
  kind: FlowKind;
  pending?: PendingConfirmation;
  pendingTimer?: ReturnType<typeof setTimeout>;
  platformOrigin: string;
  redirectUri?: string;
  remoteServerUrl?: string;
  restartCount: number;
  snapshot?: PlatformSnapshot;
  startedAt: number;
  state: string;
  storageMode: StorageMode;
  switchOrganization: boolean;
}

class FlowFailure extends Error {
  constructor(
    readonly code: AuthorizationErrorCode,
    message: string,
  ) {
    super(message);
  }
}

class EndpointChangedSignal extends Error {}

export interface AuthFlowHost {
  /** Runs after a successful commit: start refresh, reconnect the gateway. */
  afterCommit: () => void;
  allowLoopbackHttp: boolean;
  broadcast: (channel: string, payload?: unknown) => void;
  /** Persist tokens + tenant record + active in one atomic write. */
  commit: (params: {
    display: CloudTenantDisplay;
    entryUrl: string;
    generation: string;
    identity: CloudTenantIdentity;
    remoteServerUrl?: string;
    storageMode: StorageMode;
    tokens: Tokens;
  }) => Promise<void>;
  getCommittedTenant: () => Promise<CloudTenant | undefined>;
  jwks: JwksResolver;
  openExternal: (url: string) => Promise<void>;
  platformOrigin: () => string;
}

interface FlowInit {
  entry?: string;
  expectedTenantId?: string;
  kind: FlowKind;
  remoteServerUrl?: string;
  restartCount: number;
  storageMode: StorageMode;
  switchOrganization: boolean;
}

const failure = (code: AuthorizationErrorCode, error: string): AuthorizationStartResult => ({
  code,
  error,
  success: false,
});

const safeMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

const base64Url = (buffer: Buffer) =>
  buffer.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');

/**
 * One desktop sign-in at a time. Every asynchronous step re-checks that its flow is still
 * the current one, so a cancelled, superseded or replaced flow (including its late network
 * responses) can never bind an entry, store tokens or become active.
 */
export class AuthFlowManager {
  private flow: Flow | null = null;

  constructor(private readonly host: AuthFlowHost) {}

  // ---------------------------------------------------------------- public API

  /** Start from the user's config: known entry when it names one, else the platform page. */
  async start(config: DataSyncConfig, options: { forceDiscovery?: boolean } = {}) {
    const platformOrigin = this.host.platformOrigin();
    const committed = await this.host.getCommittedTenant();

    if (config.storageMode === 'cloud') {
      if (committed && !options.forceDiscovery) {
        return this.begin({
          entry: committed.entryUrl,
          expectedTenantId: committed.identity.tenantId,
          kind: 'known-entry',
          restartCount: 0,
          storageMode: 'cloud',
          switchOrganization: false,
        });
      }
      return this.begin({
        expectedTenantId: options.forceDiscovery ? committed?.identity.tenantId : undefined,
        kind: 'platform',
        restartCount: 0,
        storageMode: 'cloud',
        switchOrganization: false,
      });
    }

    const entry = normalizeEntryUrl(config.remoteServerUrl ?? '', this.host.allowLoopbackHttp);
    if (!entry) {
      return failure('INVALID_SERVER_ADDRESS', 'The server address is not a valid https address');
    }

    const { kind } = classifyEntry(entry, platformOrigin);
    if (kind === 'invalid') {
      return failure(
        'INVALID_ORGANIZATION_ADDRESS',
        'The address is not a valid organization address',
      );
    }
    if (kind === 'platform') {
      return this.begin({
        kind: 'platform',
        remoteServerUrl: entry,
        restartCount: 0,
        storageMode: 'selfHost',
        switchOrganization: false,
      });
    }

    return this.begin({
      entry,
      expectedTenantId: committed?.entryUrl === entry ? committed.identity.tenantId : undefined,
      kind: 'known-entry',
      remoteServerUrl: entry,
      restartCount: 0,
      storageMode: 'selfHost',
      switchOrganization: false,
    });
  }

  /** Always the platform organization page (optionally forcing a fresh choice). */
  startPlatform(options: { expectedTenantId?: string; switchOrganization?: boolean } = {}) {
    return this.begin({
      expectedTenantId: options.expectedTenantId,
      kind: 'platform',
      restartCount: 0,
      storageMode: 'cloud',
      switchOrganization: options.switchOrganization === true,
    });
  }

  cancel(reason: AuthorizationConfirmDismissReason = 'cancelled'): boolean {
    if (!this.flow) return false;
    this.discard(reason);
    this.host.broadcast('authorizationProgress', {
      elapsed: 0,
      maxPollTime: MAX_POLL_TIME,
      phase: 'cancelled' satisfies AuthorizationPhase,
    });
    return true;
  }

  hasActiveFlow() {
    return this.flow !== null;
  }

  getPendingRequest(): AuthorizationConfirmRequest | null {
    const pending = this.flow?.pending;
    return pending ? this.toRequest(pending) : null;
  }

  async confirm(params: AuthorizationConfirmParams): Promise<AuthorizationConfirmResult> {
    const flow = this.matchPending(params);
    if (!flow?.pending) {
      return {
        code: 'CONFIRMATION_INVALID',
        error: 'No such pending confirmation',
        success: false,
      };
    }

    const pending = flow.pending;
    if (Date.now() > pending.expiresAt) {
      this.expire(flow);
      return { code: 'CONFIRMATION_TIMEOUT', error: 'The confirmation expired', success: false };
    }

    // Single use: the pending object is consumed before anything asynchronous happens.
    flow.pending = undefined;
    clearTimeout(flow.pendingTimer);

    try {
      await this.commit(flow, pending);
      return { success: true };
    } catch (error) {
      logger.error(`Committing the authorization failed: ${safeMessage(error)}`);
      // The pending login is consumed for good: a failed commit is not retryable with the
      // same confirmation, the card is closed and the user starts a new login.
      this.host.broadcast('authorizationConfirmDismissed', {
        confirmationId: pending.confirmationId,
        reason: 'cancelled' satisfies AuthorizationConfirmDismissReason,
      });
      this.fail(flow, 'UNKNOWN', safeMessage(error));
      return { code: 'COMMIT_FAILED', error: safeMessage(error), success: false };
    }
  }

  cancelConfirmation(params: AuthorizationConfirmParams): { success: boolean } {
    const flow = this.matchPending(params);
    if (!flow) return { success: false };

    this.discard('cancelled');
    this.host.broadcast('authorizationProgress', {
      elapsed: 0,
      maxPollTime: MAX_POLL_TIME,
      phase: 'cancelled' satisfies AuthorizationPhase,
    });
    return { success: true };
  }

  /** "Switch organization" on the confirmation card: drop the pending login, choose again. */
  async switchFromConfirmation(params: AuthorizationConfirmParams) {
    const flow = this.matchPending(params);
    if (!flow) return failure('FLOW_SUPERSEDED', 'No such pending confirmation');

    const keepsPlatformConfig = flow.kind === 'platform';
    const { remoteServerUrl, storageMode } = flow;
    this.discard('switched');

    return this.begin({
      kind: 'platform',
      remoteServerUrl: keepsPlatformConfig ? remoteServerUrl : undefined,
      restartCount: 0,
      storageMode: keepsPlatformConfig ? storageMode : 'cloud',
      switchOrganization: true,
    });
  }

  dispose() {
    this.discard('cancelled');
  }

  // ---------------------------------------------------------------- flow start

  private isCurrent(flow: Flow) {
    return this.flow === flow;
  }

  private async begin(init: FlowInit): Promise<AuthorizationStartResult> {
    this.discard('superseded');

    const codeVerifier = base64Url(crypto.randomBytes(32));
    const codeChallenge = base64Url(
      crypto.createHash('sha256').update(codeVerifier, 'utf8').digest(),
    );

    const flow: Flow = {
      codeChallenge,
      codeVerifier,
      expectedTenantId: init.expectedTenantId,
      generation: crypto.randomUUID(),
      kind: init.kind,
      platformOrigin: this.host.platformOrigin(),
      remoteServerUrl: init.remoteServerUrl,
      restartCount: init.restartCount,
      startedAt: Date.now(),
      state: crypto.randomBytes(16).toString('hex'),
      storageMode: init.storageMode,
      switchOrganization: init.switchOrganization,
    };
    this.flow = flow;
    logger.info(`Authorization started (kind=${flow.kind}, restarts=${flow.restartCount})`);

    let url: string;
    if (flow.kind === 'known-entry') {
      const entry = init.entry!;

      const preflight = await preflightEntry(entry);
      if (!this.isCurrent(flow)) return failure('FLOW_SUPERSEDED', 'Authorization was replaced');

      if (preflight === 'endpoint_changed') {
        const restart = await this.restartAfterEndpointChange({ ...flow, entry });
        if (restart.restarted === true) return restart.result;
        this.discard('cancelled');
        return failure(restart.code, restart.message);
      }
      if (preflight !== 'ok') {
        this.discard('cancelled');
        return failure(
          'INVALID_ORGANIZATION_ADDRESS',
          'The address is not a valid organization address',
        );
      }

      this.bindEntry(flow, entry);
      url = this.buildAuthorizeUrl(flow);
    } else {
      const platformUrl = buildRemoteUrl('/', flow.platformOrigin);
      platformUrl.search = querystring.stringify({
        client: 'desktop',
        state: flow.state,
        code_challenge: flow.codeChallenge,
        ...(flow.switchOrganization ? { switch: '1' } : {}),
      });
      url = platformUrl.toString();
    }

    try {
      await this.host.openExternal(url);
    } catch {
      if (this.isCurrent(flow)) this.discard('cancelled');
      return failure('UNKNOWN', 'Failed to open the system browser');
    }
    if (!this.isCurrent(flow)) return failure('FLOW_SUPERSEDED', 'Authorization was replaced');

    this.host.broadcast('authorizationProgress', {
      elapsed: 0,
      maxPollTime: flow.kind === 'platform' ? PLATFORM_MAX_WAIT_MS : MAX_POLL_TIME,
      phase: 'browser_opened' satisfies AuthorizationPhase,
    });

    void this.run(flow);
    return { success: true };
  }

  private bindEntry(flow: Flow, entry: string) {
    flow.entry = entry;
    flow.expectedIssuer = buildExpectedIssuer(entry);
    flow.redirectUri = buildRemoteUrl('/oidc/callback/desktop', entry).toString();
  }

  private buildAuthorizeUrl(flow: Flow) {
    const url = buildRemoteUrl('/oidc/auth', flow.entry!);
    url.search = querystring.stringify({
      client_id: DESKTOP_CLIENT_ID,
      code_challenge: flow.codeChallenge,
      code_challenge_method: 'S256',
      prompt: 'consent',
      redirect_uri: flow.redirectUri,
      // https://github.com/lobehub/lobe-chat/pull/8450
      resource: RESOURCE,
      response_type: 'code',
      scope: AUTH_SCOPE,
      state: flow.state,
    });
    return url.toString();
  }

  // ---------------------------------------------------------------- flow run

  private async run(flow: Flow) {
    try {
      if (flow.kind === 'platform') {
        const snapshot = await this.waitForSnapshot(flow);
        if (!snapshot || !this.isCurrent(flow)) return;

        if (flow.expectedTenantId && snapshot.tenantId !== flow.expectedTenantId) {
          this.fail(
            flow,
            'ORGANIZATION_CHANGED_SWITCH_REQUIRED',
            'The organization changed; choose "switch organization" explicitly',
          );
          return;
        }

        // Only the first snapshot is ever bound for this flow.
        flow.snapshot = snapshot;
        this.bindEntry(flow, snapshot.entry);
      }

      const code = await this.waitForCode(flow);
      if (code === null || !this.isCurrent(flow)) return;

      await this.complete(flow, code);
    } catch (error) {
      this.fail(flow, 'UNKNOWN', safeMessage(error));
    }
  }

  private sleep(flow: Flow, ms: number) {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        flow.cancelSleep = undefined;
        resolve();
      }, ms);
      flow.cancelSleep = () => {
        clearTimeout(timer);
        flow.cancelSleep = undefined;
        resolve();
      };
    });
  }

  /**
   * Poll until `poll` yields a value. Pending answers wait the normal interval, 429 honours
   * Retry-After, transient failures back off exponentially up to a bounded count.
   */
  private async pollUntil<T>(
    flow: Flow,
    options: {
      maxPollTime: number;
      phase: AuthorizationPhase;
      poll: () => Promise<
        | { retryAfterMs: number; status: 'rate_limited' }
        | { status: 'pending' | 'stop' | 'transient' }
        | { status: 'done'; value: T }
      >;
      unavailable: string;
    },
  ): Promise<T | null> {
    const startedAt = Date.now();
    let failures = 0;

    for (;;) {
      if (!this.isCurrent(flow)) return null;

      const elapsed = Date.now() - startedAt;
      if (elapsed > options.maxPollTime) {
        this.fail(flow, 'AUTHORIZATION_TIMEOUT', 'Authorization timed out');
        return null;
      }
      this.host.broadcast('authorizationProgress', {
        elapsed,
        maxPollTime: options.maxPollTime,
        phase: options.phase,
      });

      const result = await options.poll();
      if (!this.isCurrent(flow)) return null;

      let delay = POLL_INTERVAL;
      switch (result.status) {
        case 'done': {
          return result.value;
        }
        case 'stop': {
          return null;
        }
        case 'pending': {
          failures = 0;
          break;
        }
        case 'rate_limited': {
          failures = 0;
          delay = result.retryAfterMs;
          break;
        }
        case 'transient': {
          failures += 1;
          if (failures >= MAX_TRANSIENT_FAILURES) {
            this.fail(flow, 'PLATFORM_UNAVAILABLE', options.unavailable);
            return null;
          }
          delay = Math.min(POLL_INTERVAL * 2 ** (failures - 1), BACKOFF_CAP_MS);
          break;
        }
      }

      await this.sleep(flow, delay);
    }
  }

  private waitForSnapshot(flow: Flow) {
    return this.pollUntil<PlatformSnapshot>(flow, {
      maxPollTime: PLATFORM_MAX_WAIT_MS,
      phase: 'waiting_for_organization',
      poll: async () => {
        const result = await requestDesktopHandoff(
          flow.platformOrigin,
          { codeChallenge: flow.codeChallenge, state: flow.state },
          this.host.allowLoopbackHttp,
        );
        if (!this.isCurrent(flow)) return { status: 'stop' };

        switch (result.status) {
          case 'ready': {
            return { status: 'done', value: result.snapshot };
          }
          case 'rejected': {
            this.fail(
              flow,
              'PLATFORM_HANDOFF_REJECTED',
              'The platform rejected the sign-in request',
            );
            return { status: 'stop' };
          }
          case 'invalid': {
            this.fail(flow, 'HANDOFF_INCONSISTENT', 'The platform handoff was not usable');
            return { status: 'stop' };
          }
          case 'misconfigured': {
            this.fail(
              flow,
              'PLATFORM_MISCONFIGURED',
              'The platform does not serve the desktop handoff',
            );
            return { status: 'stop' };
          }
          case 'rate_limited': {
            return result;
          }
          default: {
            return { status: result.status };
          }
        }
      },
      unavailable: 'The platform is currently unavailable',
    });
  }

  private waitForCode(flow: Flow) {
    return this.pollUntil<string>(flow, {
      maxPollTime: MAX_POLL_TIME,
      phase: 'waiting_for_auth',
      poll: async () => {
        const result = await pollTenantHandoff(flow.entry!, flow.state);
        if (!this.isCurrent(flow)) return { status: 'stop' };

        switch (result.status) {
          case 'ready': {
            if (result.state !== flow.state) {
              this.fail(flow, 'HANDOFF_INCONSISTENT', 'Invalid state parameter');
              return { status: 'stop' };
            }
            return { status: 'done', value: result.code };
          }
          case 'endpoint_changed': {
            await this.restartInFlow(flow);
            return { status: 'stop' };
          }
          case 'invalid_entry': {
            this.fail(
              flow,
              'INVALID_ORGANIZATION_ADDRESS',
              'The address is not a valid organization address',
            );
            return { status: 'stop' };
          }
          case 'rejected': {
            this.fail(
              flow,
              'HANDOFF_INCONSISTENT',
              'The organization rejected the handoff request',
            );
            return { status: 'stop' };
          }
          case 'unexpected': {
            return { status: 'transient' };
          }
          case 'rate_limited': {
            return result;
          }
          default: {
            return { status: result.status };
          }
        }
      },
      unavailable: 'The organization server is currently unavailable',
    });
  }

  // ---------------------------------------------------------------- 409 handling

  /**
   * A 409 TENANT_ENDPOINT_CHANGED only means "resolve the entry again". The address in the
   * response is never used: the flow restarts through the platform page with fresh state
   * and PKCE, keeping the organization the user was signing in to.
   */
  private async restartAfterEndpointChange(
    flow: Flow,
  ): Promise<
    | { code: AuthorizationErrorCode; message: string; restarted: false }
    | { restarted: true; result: AuthorizationStartResult }
  > {
    const restartable =
      flow.storageMode === 'cloud' ||
      (flow.entry ? isSameHost(flow.entry, flow.platformOrigin) : false);
    if (!restartable) {
      return {
        code: 'ENDPOINT_CHANGED_UPDATE_ADDRESS',
        message: 'The server address changed; update the address or choose the server again',
        restarted: false,
      };
    }

    const expectedTenantId = flow.snapshot?.tenantId ?? flow.expectedTenantId;
    if (!expectedTenantId) {
      return {
        code: 'ENDPOINT_CHANGED_RESTART_LIMIT',
        message: 'The organization entry changed and cannot be recovered automatically',
        restarted: false,
      };
    }
    if (flow.restartCount >= MAX_AUTO_RESTARTS) {
      return {
        code: 'ENDPOINT_CHANGED_RESTART_LIMIT',
        message: 'The organization entry kept changing during sign-in',
        restarted: false,
      };
    }

    const attempt = flow.restartCount + 1;
    this.host.broadcast('authorizationRestarting', { attempt, maxAttempts: MAX_AUTO_RESTARTS });
    logger.warn(`Tenant endpoint changed during authorization, restarting (attempt ${attempt})`);

    return {
      restarted: true,
      result: await this.begin({
        expectedTenantId,
        kind: 'platform',
        remoteServerUrl: flow.remoteServerUrl,
        restartCount: attempt,
        storageMode: flow.storageMode,
        switchOrganization: false,
      }),
    };
  }

  private async restartInFlow(flow: Flow) {
    if (!this.isCurrent(flow)) return;
    const restart = await this.restartAfterEndpointChange(flow);

    if (restart.restarted === false) {
      this.fail(flow, restart.code, restart.message);
      return;
    }

    const { result } = restart;
    if (result.success === false && result.code !== 'FLOW_SUPERSEDED') {
      this.host.broadcast('authorizationFailed', { code: result.code, error: result.error });
    }
  }

  // ---------------------------------------------------------------- exchange + verify

  private async exchangeCode(flow: Flow, code: string): Promise<Tokens & { idToken: string }> {
    const tokenUrl = buildRemoteUrl('/oidc/token', flow.entry!);
    const body = querystring.stringify({
      client_id: DESKTOP_CLIENT_ID,
      code,
      code_verifier: flow.codeVerifier,
      grant_type: 'authorization_code',
      redirect_uri: flow.redirectUri,
    });
    const headers: Record<string, string> = {
      'Content-Type': 'application/x-www-form-urlencoded',
    };
    appendVercelCookie(headers);
    setDesktopUserAgentHeader(headers);

    logger.debug('Sending token exchange request');
    const response = await fetchNoRedirect(tokenUrl.toString(), { body, headers, method: 'POST' });

    if (response.status === 409 && (await isEndpointChangedResponse(response.clone()))) {
      throw new EndpointChangedSignal();
    }

    if (!response.ok) {
      const errorData = await readJsonLimited<{ error?: string; error_description?: string }>(
        response,
        MAX_TOKEN_RESPONSE_BYTES,
      ).catch(() => ({}) as { error?: string; error_description?: string });
      throw new FlowFailure(
        'TOKEN_EXCHANGE_FAILED',
        `Failed to get token: ${response.status} ${errorData.error_description || errorData.error || ''}`.trim(),
      );
    }

    let data: Record<string, unknown>;
    try {
      data = await readJsonLimited<Record<string, unknown>>(response, MAX_TOKEN_RESPONSE_BYTES);
    } catch {
      throw new FlowFailure('TOKEN_EXCHANGE_FAILED', 'The token response was not valid JSON');
    }

    const { access_token, expires_in, id_token, refresh_token } = data;
    if (
      typeof access_token !== 'string' ||
      typeof refresh_token !== 'string' ||
      typeof id_token !== 'string'
    ) {
      // A missing id_token fails closed: there is no way to learn who just signed in.
      throw new FlowFailure(
        'TOKEN_EXCHANGE_FAILED',
        'Invalid token response: missing required fields',
      );
    }

    return {
      accessToken: access_token,
      expiresIn: typeof expires_in === 'number' ? expires_in : undefined,
      idToken: id_token,
      refreshToken: refresh_token,
    };
  }

  private async verifyTokens(flow: Flow, tokens: Tokens & { idToken: string }) {
    const common = {
      expectedIssuer: flow.expectedIssuer!,
      jwks: this.host.jwks,
      notBefore: flow.startedAt,
    };

    try {
      const [idToken, accessToken] = await Promise.all([
        verifyIdToken({ ...common, token: tokens.idToken }),
        verifyAccessToken({ ...common, token: tokens.accessToken }),
      ]);

      const tenantId = readTenantId(accessToken.claims);
      if (!tenantId) throw new Error('The access token carries no tenant');
      if (accessToken.claims.sub !== idToken.claims.sub) {
        throw new Error('The id token and access token belong to different users');
      }
      if (flow.kind === 'platform' && tenantId !== flow.snapshot?.tenantId) {
        throw new Error('The access token tenant differs from the selected organization');
      }

      // Display only: the id_token's own name wins over the platform snapshot's.
      const claims = readTenantDisplayClaims(idToken.claims);
      const organizationName = claims.name ?? (flow.snapshot?.name || undefined);

      return {
        display: {
          account: pickAccountDisplay(idToken.claims),
          ...(organizationName ? { organizationName } : {}),
          ...(claims.slug ? { organizationSlug: claims.slug } : {}),
          ...(claims.hasOtherOrganizations !== undefined
            ? { hasOtherOrganizations: claims.hasOtherOrganizations }
            : {}),
        } satisfies CloudTenantDisplay,
        identity: {
          issuer: flow.expectedIssuer!,
          subject: String(idToken.claims.sub),
          tenantId,
        } satisfies CloudTenantIdentity,
      };
    } catch (error) {
      throw new FlowFailure('IDENTITY_VERIFICATION_FAILED', safeMessage(error));
    }
  }

  private async complete(flow: Flow, code: string) {
    this.host.broadcast('authorizationProgress', {
      elapsed: Date.now() - flow.startedAt,
      maxPollTime: MAX_POLL_TIME,
      phase: 'verifying' satisfies AuthorizationPhase,
    });

    try {
      const tokens = await this.exchangeCode(flow, code);
      if (!this.isCurrent(flow)) return;

      const { display, identity } = await this.verifyTokens(flow, tokens);
      if (!this.isCurrent(flow)) return;

      const entryUrl = flow.entry!;
      const pending: PendingConfirmation = {
        confirmationId: crypto.randomUUID(),
        display,
        entryUrl,
        expiresAt: Date.now() + CONFIRMATION_TIMEOUT_MS,
        generation: flow.generation,
        identity,
        tokens: {
          accessToken: tokens.accessToken,
          expiresIn: tokens.expiresIn,
          refreshToken: tokens.refreshToken,
        },
      };

      if (await this.canSkipConfirmation(flow, pending)) {
        if (!this.isCurrent(flow)) return;
        await this.commit(flow, pending);
        return;
      }

      // Pending tokens live in memory only; the card is the user's chance to refuse them.
      flow.pending = pending;
      flow.pendingTimer = setTimeout(() => this.expire(flow), CONFIRMATION_TIMEOUT_MS);
      this.host.broadcast('authorizationProgress', {
        elapsed: Date.now() - flow.startedAt,
        maxPollTime: CONFIRMATION_TIMEOUT_MS,
        phase: 'awaiting_confirmation' satisfies AuthorizationPhase,
      });
      this.host.broadcast('authorizationConfirmRequired', this.toRequest(pending));
    } catch (error) {
      if (error instanceof EndpointChangedSignal) {
        await this.restartInFlow(flow);
      } else if (error instanceof FlowFailure) {
        this.fail(flow, error.code, error.message);
      } else {
        this.fail(flow, 'UNKNOWN', safeMessage(error));
      }
    }
  }

  /**
   * Only a known-entry re-login that matches the previously confirmed record exactly, and
   * that the user did not start as "switch organization", skips the confirmation.
   */
  private async canSkipConfirmation(flow: Flow, pending: PendingConfirmation) {
    if (flow.kind !== 'known-entry' || flow.switchOrganization) return false;

    const committed = await this.host.getCommittedTenant();
    return (
      committed !== undefined &&
      committed.entryUrl === pending.entryUrl &&
      committed.identity.issuer === pending.identity.issuer &&
      committed.identity.tenantId === pending.identity.tenantId &&
      committed.identity.subject === pending.identity.subject
    );
  }

  // ---------------------------------------------------------------- commit + teardown

  private async commit(flow: Flow, pending: PendingConfirmation) {
    // Last check before anything is written: the flow must still be the current one.
    if (!this.isCurrent(flow)) throw new Error('Authorization was replaced');

    await this.host.commit({
      display: pending.display,
      entryUrl: pending.entryUrl,
      generation: pending.generation,
      identity: pending.identity,
      remoteServerUrl: flow.remoteServerUrl,
      storageMode: flow.storageMode,
      tokens: pending.tokens,
    });

    this.flow = null;
    this.host.broadcast('authorizationConfirmDismissed', {
      confirmationId: pending.confirmationId,
      reason: 'confirmed' satisfies AuthorizationConfirmDismissReason,
    });
    this.host.afterCommit();
    this.host.broadcast('authorizationSuccessful');
  }

  private matchPending(params: AuthorizationConfirmParams): Flow | null {
    const flow = this.flow;
    const pending = flow?.pending;
    if (
      !flow ||
      !pending ||
      pending.confirmationId !== params.confirmationId ||
      pending.generation !== params.generation ||
      flow.generation !== params.generation
    ) {
      return null;
    }
    return flow;
  }

  private toRequest(pending: PendingConfirmation): AuthorizationConfirmRequest {
    return {
      account: pending.display.account,
      confirmationId: pending.confirmationId,
      entryUrl: pending.entryUrl,
      expiresAt: pending.expiresAt,
      generation: pending.generation,
      ...(pending.display.hasOtherOrganizations !== undefined
        ? { hasOtherOrganizations: pending.display.hasOtherOrganizations }
        : {}),
      ...(pending.display.organizationName ? { name: pending.display.organizationName } : {}),
      ...(pending.display.organizationSlug ? { slug: pending.display.organizationSlug } : {}),
    };
  }

  private expire(flow: Flow) {
    if (!this.isCurrent(flow) || !flow.pending) return;

    this.discard('expired');
    this.host.broadcast('authorizationFailed', {
      code: 'CONFIRMATION_TIMEOUT' satisfies AuthorizationErrorCode,
      error: 'Authorization confirmation timed out',
    });
  }

  private fail(flow: Flow, code: AuthorizationErrorCode, error: string) {
    if (!this.isCurrent(flow)) return;

    logger.warn(`Authorization failed (${code})`);
    this.discard('cancelled');
    this.host.broadcast('authorizationFailed', { code, error });
  }

  /** Invalidate the current flow for good: its pending tokens, timers and late responses. */
  private discard(reason: AuthorizationConfirmDismissReason) {
    const flow = this.flow;
    if (!flow) return;

    this.flow = null;
    flow.cancelSleep?.();

    const pending = flow.pending;
    flow.pending = undefined;
    clearTimeout(flow.pendingTimer);
    if (pending) {
      this.host.broadcast('authorizationConfirmDismissed', {
        confirmationId: pending.confirmationId,
        reason,
      });
    }
  }
}

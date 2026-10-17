import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import type { GatewayIdentityProvider } from '@lobechat/agent-gateway-client';
import { OFFICIAL_DEVICE_GATEWAY_URL } from '@lobechat/const/url';
import type {
  EnrollWorkspaceParams,
  EnrollWorkspaceResult,
  UnenrollWorkspaceParams,
} from '@lobechat/device-control';
import type { DeviceMetricsSampler } from '@lobechat/device-control/metrics';
import type {
  AgentRunRequestMessage,
  GatewayClient,
  MessageApiRequestMessage,
  RpcRequestMessage,
  SystemInfoRequestMessage,
  ToolCallRequestMessage,
} from '@lobechat/device-gateway-client';
import type { IdentitySource } from '@lobechat/device-identity';
import type { GatewayConnectionStatus } from '@lobechat/electron-client-ipc';
import { app, powerSaveBlocker } from 'electron';

import { isDev } from '@/const/env';
import { getDesktopEnv } from '@/env';
import { createLogger } from '@/utils/logger';
import { getDesktopUserAgent } from '@/utils/user-agent';
import { safeGetPath } from '@/utils/user-path';

import { GatewayExecutionHandlers } from './gatewayExecutionHandlers';
import { ServiceModule } from './index';

const logger = createLogger('services:GatewayConnectionSrv');

const DEFAULT_GATEWAY_URL = OFFICIAL_DEVICE_GATEWAY_URL;

/**
 * The socket drops about once an hour (Cloudflare moving the Durable Object,
 * edge link resets) and is back within ~2s. A drop that recovers inside this
 * window is not surfaced to the UI, so the device indicator doesn't flicker.
 */
const RECONNECT_UI_GRACE_MS = 5000;

interface DeviceRegistrar {
  (info: {
    architecture: string;
    deviceId: string;
    hostname: string;
    identitySource: IdentitySource;
    metadata: Record<string, string>;
    platform: string;
  }): Promise<void>;
}

/**
 * Check whether the workspace-scoped deviceId still has a registered row on the
 * server. Returns `false` only on a definitive "row gone" answer (share revoked
 * while offline); `undefined` when the check could not be performed — callers
 * must NOT clear local state on `undefined`.
 */
interface WorkspaceDeviceChecker {
  (workspaceId: string, deviceId: string): Promise<boolean | undefined>;
}

/**
 * GatewayConnectionService
 *
 * Core business logic for managing WebSocket connection to the cloud device-gateway.
 * Extracted from GatewayConnectionCtr so other controllers can reuse connect/disconnect.
 */
export default class GatewayConnectionService extends ServiceModule {
  private client: GatewayClient | null = null;
  private connectionEpoch = 0;
  private connectionController = new AbortController();
  private enrollmentIdentity?: string;
  private identityProviderFactory?: (
    workspaceId?: string,
    initialTicket?: string,
  ) => Promise<GatewayIdentityProvider>;

  setIdentityProviderFactory(
    factory: NonNullable<GatewayConnectionService['identityProviderFactory']>,
  ) {
    this.identityProviderFactory = factory;
  }
  private status: GatewayConnectionStatus = 'disconnected';
  private deviceId: string | null = null;
  private powerSaveBlockerId: number | null = null;
  /** Status last pushed to renderers; lags `status` during a transient drop. */
  private displayedStatus: GatewayConnectionStatus = 'disconnected';
  private statusBroadcastTimer: ReturnType<typeof setTimeout> | null = null;

  private identitySource: IdentitySource | null = null;

  private tokenProvider: (() => Promise<string | null>) | null = null;
  private readonly execution = new GatewayExecutionHandlers(this.app);
  private deviceRegistrar: DeviceRegistrar | null = null;
  /** Samples CPU / memory / load for the personal device while the connection is on. */
  private metricsSampler: { deviceId: string; sampler: DeviceMetricsSampler } | null = null;
  private workspaceDeviceChecker: WorkspaceDeviceChecker | null = null;

  /** Live workspace-share connections, keyed by workspaceId. */
  private workspaceClients = new Map<string, GatewayClient>();
  private workspaceDials = new Map<string, AbortController>();
  /** Serializes enrollment restores so reconnect churn can't double-open sockets. */
  private workspaceRestoreInFlight = false;
  // ─── Configuration ───

  /**
   * Set token provider function (to decouple from RemoteServerConfigCtr)
   */
  setTokenProvider(provider: () => Promise<string | null>) {
    this.tokenProvider = provider;
  }

  /**
   * Set tool call handler (to route tool calls to LocalFileCtr/ShellCommandCtr)
   */
  setToolCallHandler(handler: NonNullable<GatewayExecutionHandlers['toolCallHandler']>) {
    this.execution.toolCallHandler = handler;
  }

  /**
   * Set the MCP call handler (routes tunneled stdio MCP calls to McpCtr, which
   * spawns the local stdio server). Distinct from the builtin tool-call handler.
   */
  setMcpCallHandler(handler: NonNullable<GatewayExecutionHandlers['mcpCallHandler']>) {
    this.execution.mcpCallHandler = handler;
  }

  setMessageApiHandler(handler: NonNullable<GatewayExecutionHandlers['messageApiHandler']>) {
    this.execution.messageApiHandler = handler;
  }

  /**
   * Set the generic device-RPC handler (routes server-internal method calls such
   * as workspace-init to the relevant controller). Distinct from the tool-call
   * handler — these are never surfaced to the agent.
   */
  setRpcHandler(handler: NonNullable<GatewayExecutionHandlers['rpcHandler']>) {
    this.execution.rpcHandler = handler;
  }

  setAgentRunHandler(handler: NonNullable<GatewayExecutionHandlers['agentRunHandler']>) {
    this.execution.agentRunHandler = handler;
  }

  /**
   * Persist this device to the server's device registry. Called on every
   * connect once the userId is known (deviceId is user-scoped). Injected by the
   * controller, which owns the authed server URL + token.
   */
  setDeviceRegistrar(registrar: DeviceRegistrar) {
    this.deviceRegistrar = registrar;
  }

  /**
   * Set the "is this workspace device row still registered?" probe used before
   * restoring a persisted enrollment, so a share revoked while the app was
   * offline doesn't come back as a ghost device.
   */
  setWorkspaceDeviceChecker(checker: WorkspaceDeviceChecker) {
    this.workspaceDeviceChecker = checker;
  }

  // ─── Device ID ───

  /**
   * Ensure a stored fallback id exists. Pre-login this doubles as the device id
   * shown by `getDeviceInfo`; once a userId is available `resolveDeviceIdentity`
   * replaces it with a stable machine-derived id.
   */
  loadOrCreateDeviceId() {
    const stored = this.app.storeManager.get('gatewayDeviceId') as string | undefined;
    if (stored) {
      this.deviceId = stored;
    } else {
      this.deviceId = randomUUID();
      this.app.storeManager.set('gatewayDeviceId', this.deviceId);
    }
    logger.debug(`Device ID: ${this.deviceId}`);
  }

  /**
   * Derive the stable, user-scoped device id. Survives LobeHub reinstalls
   * because it hashes the OS machine id; falls back to the stored random UUID
   * when the machine id is unavailable. Caches the result for this session.
   */
  async resolveDeviceIdentity(
    userId: string,
  ): Promise<{ deviceId: string; identitySource: IdentitySource }> {
    const { deriveDeviceId } = await import('@lobechat/device-identity');
    const fallbackId = this.app.storeManager.get('gatewayDeviceId') as string | undefined;
    const identity = deriveDeviceId(userId, { fallbackId });
    this.deviceId = identity.deviceId;
    this.identitySource = identity.identitySource;
    return identity;
  }

  getDeviceId(): string {
    return this.deviceId || 'unknown';
  }

  /**
   * Connection routing key — the gateway's stale-socket dedupe key, decoupled
   * from the stable `deviceId`. Reuses the persisted random UUID (historically
   * `gatewayDeviceId`, now used purely as the connectionId) so a reconnect of
   * this install replaces only its own previous socket, while a co-running
   * `lh connect` on the same machine (same deviceId, different connectionId)
   * stays connected.
   */
  getConnectionId(): string {
    let id = this.app.storeManager.get('gatewayDeviceId') as string | undefined;
    if (!id) {
      id = randomUUID();
      this.app.storeManager.set('gatewayDeviceId', id);
    }
    return id;
  }

  // ─── Connection Status ───

  getStatus(): GatewayConnectionStatus {
    return this.status;
  }

  /** Status as shown in the UI — hides reconnects that recover quickly. */
  getDisplayedStatus(): GatewayConnectionStatus {
    return this.displayedStatus;
  }

  getDeviceInfo() {
    return {
      deviceId: this.getDeviceId(),
      hostname: os.hostname(),
      platform: process.platform,
    };
  }

  /**
   * Whether a registry device id belongs to this physical desktop.
   *
   * A machine can be reachable through both its personal identity and one
   * derived identity per persisted workspace enrollment. Reconnect deep links
   * must accept all of those identities without waking a different machine.
   */
  async matchesDeviceId(deviceId: string): Promise<boolean> {
    if (this.getDeviceId() === deviceId) return true;

    const token = await this.tokenProvider?.();
    const userId = token ? this.extractUserIdFromToken(token) : undefined;
    if (userId) {
      const identity = await this.resolveDeviceIdentity(userId);
      if (identity.deviceId === deviceId) return true;
    }

    for (const workspaceId of this.getPersistedWorkspaceEnrollments()) {
      const identity = await this.resolveWorkspaceDeviceIdentity(workspaceId);
      if (identity.deviceId === deviceId) return true;
    }

    return false;
  }

  // ─── Connection Logic ───

  async connect(): Promise<{ error?: string; success: boolean }> {
    if (this.status === 'connected' || this.status === 'connecting') {
      return { success: true };
    }
    return this.doConnect();
  }

  async disconnect(): Promise<{ success: boolean }> {
    ++this.connectionEpoch;
    this.connectionController.abort();
    this.connectionController = new AbortController();
    this.enrollmentIdentity = undefined;
    for (const dial of this.workspaceDials.values()) dial.abort();
    this.workspaceDials.clear();
    // Fence every socket synchronously before waiting for any cleanup I/O.
    const clients = [...this.workspaceClients.values(), ...(this.client ? [this.client] : [])];
    this.client = null;
    this.workspaceClients.clear();
    const closing = clients.map((client) => client.disconnect());
    this.setStatus('disconnected');
    await Promise.all(closing);
    await this.stopMetricsSampler();
    this.setStatus('disconnected');
    return { success: true };
  }

  private async doConnect(): Promise<{ error?: string; success: boolean }> {
    const epoch = ++this.connectionEpoch;
    this.connectionController.abort();
    this.connectionController = new AbortController();
    const signal = this.connectionController.signal;
    const current = () => epoch === this.connectionEpoch && !signal.aborted;
    this.setStatus('connecting');
    try {
      if (this.client) {
        const previous = this.client;
        this.client = null;
        await previous.disconnect();
      }
      if (!this.identityProviderFactory) throw new Error('GATEWAY_LOGIN_CONFIRMATION_REQUIRED');
      const provider = await this.identityProviderFactory();
      let first = await provider({ signal });
      if (!current()) return { error: 'GATEWAY_IDENTITY_CHANGED', success: false };
      const identityProvider: GatewayIdentityProvider = async (input) => {
        if (!current()) throw new Error('GATEWAY_IDENTITY_CHANGED');
        if (first) {
          const initial = first;
          first = undefined;
          return initial;
        }
        return provider(input);
      };
      const token = first.gatewayTicket;
      const userId = first.userId;
      this.enrollmentIdentity = JSON.stringify([first.tenantId, first.userId]);
      const gatewayUrl = this.getGatewayUrl();
      logger.info(`Connecting to device gateway: ${gatewayUrl}, userId: ${userId || 'unknown'}`);

      // Resolve the stable, user-scoped device id and register with the server
      // registry before opening the WS, so the device row exists by the time the
      // gateway reports it online.
      if (userId) {
        const identity = await this.resolveDeviceIdentity(userId);
        if (!current()) return { success: false };
        await this.deviceRegistrar?.({
          architecture: os.arch(),
          deviceId: identity.deviceId,
          hostname: os.hostname(),
          identitySource: identity.identitySource,
          metadata: {
            appVersion: app.getVersion(),
            electron: process.versions.electron,
            node: process.versions.node,
            osRelease: os.release(),
          },
          platform: process.platform,
        }).catch((err) => {
          logger.warn(`Device registration failed (non-fatal): ${(err as Error).message}`);
        });
      }

      const { GatewayClient } = await import('@lobechat/device-gateway-client');
      if (!current()) return { success: false };
      const client = new GatewayClient({
        identityProvider,
        channel: isDev ? 'desktop-dev' : 'desktop',
        connectionId: this.getConnectionId(),
        deviceId: this.getDeviceId(),
        gatewayUrl,
        logger,
        tunnel: false,
        token,
        userAgent: getDesktopUserAgent(),
        userId: userId || undefined,
      });

      this.setupClientEvents(client);
      this.client = client;

      await client.connect();

      return { success: true };
    } catch (error) {
      if (current()) this.setStatus('disconnected');
      return {
        error: error instanceof Error ? error.message : 'GATEWAY_IDENTITY_REJECTED',
        success: false,
      };
    }
  }

  /**
   * Bind the shared request handlers. All request routing (tool calls / RPCs /
   * agent runs / system info) is identical for the personal connection and a
   * workspace share connection; only connection lifecycle differs — a workspace
   * scope skips global status broadcasting and refreshes its token by
   * re-minting a workspace connect token instead of refreshing the user token.
   */
  private setupClientEvents(client: GatewayClient, scope?: { workspaceId: string }) {
    const current = () =>
      scope ? this.workspaceClients.get(scope.workspaceId) === client : this.client === client;
    if (scope) {
      client.on('status_changed', (status) => {
        logger.info(`Workspace ${scope.workspaceId} connection status: ${status}`);
      });
    } else {
      client.on('status_changed', (status) => {
        if (current()) this.setStatus(status);
      });
    }

    client.on('tool_call_request', (request) => {
      this.handleToolCallRequest(request, client);
    });

    client.on('message_api_request', (request) => {
      this.handleMessageApiRequest(request, client);
    });

    client.on('system_info_request', (request) => {
      void this.handleSystemInfoRequest(client, request);
    });

    client.on('rpc_request', (request) => {
      this.handleRpcRequest(client, request);
    });

    client.on('agent_run_request', (request) => {
      this.handleAgentRunRequest(client, request, scope?.workspaceId);
    });

    client.on('auth_expired', () => {
      if (current()) void client.reconnect();
    });
    client.on('auth_failed', (reason) => {
      if (!current()) return;
      logger.warn(
        scope && reason === 'FORBIDDEN'
          ? this.workspaceAdminMessage()
          : `Gateway authentication stopped: ${reason}`,
      );
      if (scope) void this.closeWorkspaceClient(scope.workspaceId);
      else {
        for (const id of this.workspaceClients.keys()) void this.closeWorkspaceClient(id);
        void client.disconnect();
        this.setStatus('disconnected');
      }
    });
    client.on('connected', () => {
      if (!current() || scope) return;
      void this.restoreWorkspaceEnrollments().catch((error) =>
        logger.warn('Workspace enrollment restore failed:', error),
      );
    });

    client.on('replaced', () => {
      logger.warn(
        `Gateway connection${scope ? ` for workspace ${scope.workspaceId}` : ''} was taken over by another client with the same connection id; not reconnecting`,
      );
    });

    client.on('error', (error) => {
      logger.error('WebSocket error:', error.message);
    });
  }

  // ─── Workspace Share Connections ───
  //
  // The server shares this personal device into a workspace by sending an
  // `enrollWorkspace` RPC over the personal connection. The app then keeps a
  // second gateway connection per shared workspace — authenticated with a
  // short-lived workspace-device connect token and identified by the
  // workspace-derived deviceId — so the machine is simultaneously reachable as
  // a personal device and as a device of each shared workspace.

  /**
   * Handle the `enrollWorkspace` device RPC: open the share connection and
   * persist the enrollment, returning the derived identity so the SERVER can
   * register the workspace device row (the desktop never calls
   * `registerWorkspaceDevice` itself on this path).
   */
  async enrollWorkspace(params: EnrollWorkspaceParams): Promise<EnrollWorkspaceResult> {
    // Dry-run probe: return the derived identity so the server can detect an
    // existing enrollment (and ask for overwrite confirmation) without this
    // machine opening or persisting anything.
    if (params.identityOnly) return this.resolveWorkspaceDeviceIdentity(params.workspaceId);
    const identity = await this.openWorkspaceClient(params.workspaceId, params.token);
    this.persistWorkspaceEnrollment(params.workspaceId);
    logger.info(`Enrolled into workspace ${params.workspaceId} as device ${identity.deviceId}`);
    return identity;
  }

  /**
   * Handle the `unenrollWorkspace` device RPC (share revoked): close the share
   * connection and drop the persisted auto-reconnect state. The instruction may
   * arrive on the workspace connection or the personal one — both route here.
   */
  async unenrollWorkspace(params: UnenrollWorkspaceParams): Promise<{ success: boolean }> {
    await this.closeWorkspaceClient(params.workspaceId);
    this.removePersistedWorkspaceEnrollment(params.workspaceId);
    logger.info(`Unenrolled from workspace ${params.workspaceId}`);
    return { success: true };
  }

  /**
   * Identity for a WORKSPACE share connection. MUST stay byte-compatible with
   * the CLI's `resolveWorkspaceDeviceIdentity` (apps/cli/src/device/register.ts):
   * both hash the `workspace:<id>` principal, so the same physical machine
   * enrolled into a workspace — via desktop share or `lh connect --workspace` —
   * resolves to one workspace device.
   */
  private async resolveWorkspaceDeviceIdentity(
    workspaceId: string,
  ): Promise<EnrollWorkspaceResult> {
    const { deriveDeviceId, deriveScopedFallbackId } = await import('@lobechat/device-identity');
    // Fallback machines (no readable machine id) must still derive a STABLE
    // workspace id — the identity-only probe, the real enroll, and restore
    // checks each re-derive it. Namespace the persisted install UUID rather
    // than passing it raw: the raw UUID IS the personal deviceId on fallback
    // machines, and reusing it here would collide the two pools.
    const storedFallback = this.app.storeManager.get('gatewayDeviceId') as string | undefined;
    return deriveDeviceId(`workspace:${workspaceId}`, {
      fallbackId: storedFallback
        ? deriveScopedFallbackId(storedFallback, `workspace:${workspaceId}`)
        : undefined,
    });
  }

  private async openWorkspaceClient(
    workspaceId: string,
    token?: string,
  ): Promise<EnrollWorkspaceResult> {
    const epoch = this.connectionEpoch;
    if (!this.identityProviderFactory || !this.client) throw new Error('GATEWAY_IDENTITY_CHANGED');
    await this.closeWorkspaceClient(workspaceId);
    if (epoch !== this.connectionEpoch || !this.client) throw new Error('GATEWAY_IDENTITY_CHANGED');
    const dial = new AbortController();
    this.workspaceDials.set(workspaceId, dial);
    const signal = AbortSignal.any([dial.signal, this.connectionController.signal]);
    const assertCurrent = () => {
      signal.throwIfAborted();
      if (
        epoch !== this.connectionEpoch ||
        this.workspaceDials.get(workspaceId) !== dial ||
        !this.client
      )
        throw new Error('GATEWAY_IDENTITY_CHANGED');
    };
    let provider: GatewayIdentityProvider;
    let first: Awaited<ReturnType<GatewayIdentityProvider>> | undefined;
    try {
      provider = await this.identityProviderFactory(workspaceId, token);
      assertCurrent();
      first = await provider({ signal });
      assertCurrent();
    } catch (error) {
      if (this.workspaceDials.get(workspaceId) === dial) this.workspaceDials.delete(workspaceId);
      dial.abort();
      if ((error as { code?: string }).code === 'FORBIDDEN')
        throw new Error(this.workspaceAdminMessage(), { cause: error });
      throw error;
    }
    const identityProvider: GatewayIdentityProvider = async (input) => {
      if (epoch !== this.connectionEpoch || signal.aborted)
        throw new Error('GATEWAY_IDENTITY_CHANGED');
      input.signal.throwIfAborted();
      if (first) {
        const result = first;
        first = undefined;
        return result;
      }
      return provider(input);
    };

    const identity = await this.resolveWorkspaceDeviceIdentity(workspaceId);
    assertCurrent();

    const { GatewayClient } = await import('@lobechat/device-gateway-client');
    assertCurrent();
    const client = new GatewayClient({
      identityProvider,
      channel: isDev ? 'desktop-dev' : 'desktop',
      // Reuse the install's connectionId: the gateway dedupes stale sockets per
      // principal, so the workspace connection only ever replaces its own
      // predecessor, never the personal socket.
      connectionId: this.getConnectionId(),
      deviceId: identity.deviceId,
      gatewayUrl: this.getGatewayUrl(),
      logger,
      tunnel: false,
      token: first.gatewayTicket,
      userAgent: getDesktopUserAgent(),
      userId: undefined,
      workspaceId,
    });

    this.setupClientEvents(client, { workspaceId });
    this.workspaceClients.set(workspaceId, client);

    await client.connect();
    return identity;
  }

  private workspaceAdminMessage() {
    return this.app.i18n.ns('common')('gateway.workspaceAdminRequired');
  }

  private async closeWorkspaceClient(workspaceId: string) {
    this.workspaceDials.get(workspaceId)?.abort();
    this.workspaceDials.delete(workspaceId);
    const client = this.workspaceClients.get(workspaceId);
    if (!client) return;
    this.workspaceClients.delete(workspaceId);
    await client.disconnect();
  }

  /**
   * Re-open share connections persisted by a previous run. Before reconnecting,
   * confirm the derived workspace deviceId still has a registered row — the
   * share may have been revoked while the app was offline (the server can't
   * deliver `unenrollWorkspace` to a dead socket), and reconnecting anyway
   * would resurrect the device as a ghost in the workspace pool.
   */
  private async restoreWorkspaceEnrollments() {
    if (this.workspaceRestoreInFlight) return;
    this.workspaceRestoreInFlight = true;
    const epoch = this.connectionEpoch;

    try {
      for (const workspaceId of this.getPersistedWorkspaceEnrollments()) {
        // Already live (e.g. personal reconnect after auth refresh) — leave it.
        if (epoch !== this.connectionEpoch || !this.client) return;
        if (this.workspaceClients.has(workspaceId)) continue;

        try {
          const identity = await this.resolveWorkspaceDeviceIdentity(workspaceId);

          const registered = await this.workspaceDeviceChecker?.(workspaceId, identity.deviceId);
          if (epoch !== this.connectionEpoch) return;
          if (registered === false) {
            logger.info(
              `Workspace share ${workspaceId} was revoked while offline, clearing local enrollment`,
            );
            this.removePersistedWorkspaceEnrollment(workspaceId);
            continue;
          }

          if (epoch !== this.connectionEpoch) return;
          await this.openWorkspaceClient(workspaceId);
          logger.info(`Restored workspace share connection: ${workspaceId}`);
        } catch (error) {
          // Degraded by design: keep the record and retry on the next connect
          // rather than silently dropping the share on a transient failure.
          logger.warn(`Failed to restore workspace share ${workspaceId} (non-fatal):`, error);
        }
      }
    } finally {
      this.workspaceRestoreInFlight = false;
    }
  }

  // ─── Workspace Enrollment Persistence ───

  private getPersistedWorkspaceEnrollments(): string[] {
    if (!this.enrollmentIdentity) return [];
    const stored = this.app.storeManager.get('gatewayWorkspaceEnrollmentsByIdentity')?.[
      this.enrollmentIdentity
    ];
    return Array.isArray(stored) ? stored.filter((id) => typeof id === 'string') : [];
  }

  private persistWorkspaceEnrollment(workspaceId: string) {
    const current = this.getPersistedWorkspaceEnrollments();
    if (current.includes(workspaceId)) return;
    if (!this.enrollmentIdentity) return;
    this.app.storeManager.set('gatewayWorkspaceEnrollmentsByIdentity', {
      ...this.app.storeManager.get('gatewayWorkspaceEnrollmentsByIdentity'),
      [this.enrollmentIdentity]: [...current, workspaceId],
    });
  }

  private removePersistedWorkspaceEnrollment(workspaceId: string) {
    const current = this.getPersistedWorkspaceEnrollments();
    if (!current.includes(workspaceId)) return;
    if (!this.enrollmentIdentity) return;
    this.app.storeManager.set('gatewayWorkspaceEnrollmentsByIdentity', {
      ...this.app.storeManager.get('gatewayWorkspaceEnrollmentsByIdentity'),
      [this.enrollmentIdentity]: current.filter((id) => id !== workspaceId),
    });
  }

  private handleSystemInfoRequest(client: GatewayClient, request: SystemInfoRequestMessage) {
    return this.execution.handleSystemInfoRequest(client, request);
  }
  private handleRpcRequest(client: GatewayClient, request: RpcRequestMessage) {
    return this.execution.handleRpcRequest(client, request);
  }
  private handleAgentRunRequest(
    client: GatewayClient,
    request: AgentRunRequestMessage,
    workspaceId?: string,
  ) {
    return this.execution.handleAgentRunRequest(client, request, workspaceId);
  }
  private handleToolCallRequest(request: ToolCallRequestMessage, client: GatewayClient) {
    return this.execution.handleToolCallRequest(request, client);
  }
  private handleMessageApiRequest(request: MessageApiRequestMessage, client: GatewayClient) {
    return this.execution.handleMessageApiRequest(request, client);
  }

  // ─── Power Save Blocker ───

  getKeepAwake(): boolean {
    return this.app.storeManager.get('gatewayKeepAwake', true);
  }

  setKeepAwake(enabled: boolean) {
    this.app.storeManager.set('gatewayKeepAwake', enabled);
    logger.info(`Keep awake while connected: ${enabled}`);
    this.syncPowerSaveBlocker();
  }

  /**
   * Hold the blocker for as long as the device is meant to be online — not
   * just while the socket is `connected`. Releasing it on every transient drop
   * (the socket blips every few tens of minutes) hands macOS a window to idle
   * sleep: with the default "sleep 1 minute after the display turns off" the
   * idle timer has long expired, so the machine sleeps before the ~2s reconnect
   * lands and stays offline until the user comes back. Only an explicit
   * disconnect (status settles on `disconnected`) or the user opting out lets
   * the system sleep again.
   */
  private syncPowerSaveBlocker() {
    if (this.status !== 'disconnected' && this.getKeepAwake()) {
      this.startPowerSaveBlocker();
    } else {
      this.stopPowerSaveBlocker();
    }
  }

  /**
   * 'prevent-app-suspension' keeps the system from idle-sleeping (and App Nap
   * from suspending the process) while still letting the display sleep.
   */
  private startPowerSaveBlocker() {
    if (this.powerSaveBlockerId !== null) return;
    this.powerSaveBlockerId = powerSaveBlocker.start('prevent-app-suspension');
    logger.info(`Power save blocker started (id=${this.powerSaveBlockerId})`);
  }

  private stopPowerSaveBlocker() {
    if (this.powerSaveBlockerId === null) return;
    powerSaveBlocker.stop(this.powerSaveBlockerId);
    logger.info(`Power save blocker stopped (id=${this.powerSaveBlockerId})`);
    this.powerSaveBlockerId = null;
  }

  // ─── Device Metrics ───

  /**
   * Keeps sampling across drops and reconnects (that stretch is what explains
   * a drop); only a new identity or an explicit disconnect replaces it.
   * Samples go to the device gateway (their only store) over the personal
   * connection, whichever client instance currently holds it.
   */
  private async startMetricsSampler(deviceId: string) {
    if (this.metricsSampler?.deviceId === deviceId) return;
    await this.stopMetricsSampler();

    const userData = safeGetPath('userData');
    const { DeviceMetricsSampler, deviceMetricsBacklogFileName, pushMetrics } =
      await import('@lobechat/device-control/metrics');
    const sampler = new DeviceMetricsSampler({
      isConnected: () => this.status === 'connected',
      logger: { warn: (msg) => logger.warn(msg) },
      storagePath: userData
        ? path.join(userData, 'device-metrics', deviceMetricsBacklogFileName(deviceId))
        : undefined,
      // Mirrored to the workspace-share connections so a shared device's
      // workspace row has the same history (the gateway stores per socket).
      upload: async (samples) => {
        if (!this.client) throw new Error('Gateway not connected');
        await pushMetrics(this.client, this.workspaceClients.values(), samples);
      },
    });
    this.metricsSampler = { deviceId, sampler };
    await sampler.start();
  }

  private async stopMetricsSampler(options?: { flushTimeoutMs?: number }) {
    const current = this.metricsSampler;
    this.metricsSampler = null;
    await current?.sampler.stop(options);
  }

  // ─── Status Broadcasting ───

  private setStatus(status: GatewayConnectionStatus) {
    if (this.status === status) return;

    logger.info(`Connection status: ${this.status} → ${status}`);
    this.status = status;

    // Upload what accrued while offline right away, not at the next tick.

    this.syncPowerSaveBlocker();
    this.scheduleStatusBroadcast(status);
  }

  private scheduleStatusBroadcast(status: GatewayConnectionStatus) {
    if (this.statusBroadcastTimer) {
      clearTimeout(this.statusBroadcastTimer);
      this.statusBroadcastTimer = null;
    }

    // Leaving `connected` for a reconnect: hold the UI on `connected` for a
    // grace period. An explicit `disconnected` is always shown immediately.
    const isTransientDrop =
      this.displayedStatus === 'connected' && status !== 'connected' && status !== 'disconnected';
    if (isTransientDrop) {
      this.statusBroadcastTimer = setTimeout(() => {
        this.statusBroadcastTimer = null;
        this.broadcastStatus(this.status);
      }, RECONNECT_UI_GRACE_MS);
      return;
    }

    this.broadcastStatus(status);
  }

  private broadcastStatus(status: GatewayConnectionStatus) {
    if (this.displayedStatus === status) return;
    this.displayedStatus = status;
    this.app.browserManager.broadcastToAllWindows('gatewayConnectionStatusChanged', { status });
  }

  // ─── Gateway URL ───

  private getGatewayUrl(): string {
    // Env override wins (dev: point at a local `wrangler dev` gateway), then the
    // user-configured store value, then the production default.
    return (
      getDesktopEnv().DEVICE_GATEWAY_URL ||
      this.app.storeManager.get('gatewayUrl') ||
      DEFAULT_GATEWAY_URL
    );
  }

  // ─── Token Helpers ───

  /**
   * Extract userId (sub claim) from JWT without verification.
   * The token will be verified server-side; we just need the userId for routing.
   */
  private extractUserIdFromToken(token: string): string | null {
    try {
      const parts = token.split('.');
      if (parts.length !== 3) return null;

      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
      return payload.sub || null;
    } catch {
      logger.warn('Failed to extract userId from JWT token');
      return null;
    }
  }
}

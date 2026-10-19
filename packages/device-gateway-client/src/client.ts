import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import os from 'node:os';

import type { DeviceMetricSample, GatewayIdentityProvider } from '@lobechat/types';
import WebSocket from 'ws';

import {
  assertGatewayIdentityContinuity,
  gatewayIdentityFailure,
} from '../../agent-gateway-client/src/identity';
import { GatewayIdentityRenewal } from '../../agent-gateway-client/src/identityRenewal';
import type { GatewayCommandBinding } from '../../agent-gateway-client/src/tenancy';
import {
  gatewayIdentityHint,
  GatewaySocketAuthority,
  strictGatewayUrl,
} from '../../agent-gateway-client/src/tenancy';
import {
  assertDeviceCommandPayload,
  attachGatewaySocket,
  describeGatewayTokenExpiry,
} from './socket';
import type {
  AgentRunAckMessage,
  AgentRunRequestMessage,
  ClientMessage,
  ConnectionStatus,
  GatewayClientEvents,
  MessageApiRequestMessage,
  MessageApiResponseMessage,
  RpcRequestMessage,
  RpcResponseMessage,
  ServerMessage,
  SystemInfoRequestMessage,
  SystemInfoResponseMessage,
  ToolCallRequestMessage,
  ToolCallResponseMessage,
} from './types';

// ─── Constants ───

const DEFAULT_GATEWAY_URL = 'https://device-gateway.lobehub.com';
const HEARTBEAT_INTERVAL = 30_000; // 30s
const INITIAL_RECONNECT_DELAY = 1000; // 1s
const MAX_RECONNECT_DELAY = 30_000; // 30s
const MAX_MISSED_HEARTBEATS = 3; // Force reconnect after 3 missed acks
/**
 * Budget for the whole pre-connected window: TCP + TLS + HTTP upgrade AND the
 * `auth_success` reply. Neither phase raises an event of its own when it simply
 * hangs, so without a deadline the client waits on the OS TCP timeout — observed
 * stalling a reconnect for 15+ minutes while the device sat offline.
 */
const CONNECT_TIMEOUT = 15_000; // 15s
/**
 * Close reason the gateway sends when a newer socket with the same
 * `connectionId` takes over. `connectionId` is persisted per install, so this
 * is how a second process of the same install (two `lh connect` sharing one
 * home) shows up.
 */
const REPLACED_CLOSE_REASON = 'Replaced by new connection';

// ─── Logger Interface ───

export interface GatewayClientLogger {
  debug: (msg: string, ...args: unknown[]) => void;
  error: (msg: string, ...args: unknown[]) => void;
  info: (msg: string, ...args: unknown[]) => void;
  warn: (msg: string, ...args: unknown[]) => void;
}

const noopLogger: GatewayClientLogger = {
  debug: () => {},
  error: () => {},
  info: () => {},
  warn: () => {},
};

export interface GatewayClientOptions {
  /** Auto-reconnect on disconnection (default: true) */
  autoReconnect?: boolean;
  /**
   * Freeform routing label for this connection, e.g. `desktop` / `desktop-dev`
   * / `cli` / `cli-dev`. Used by the gateway for dispatch priority + UI; it does
   * NOT participate in stale-connection dedupe (that's `connectionId`).
   */
  channel?: string;
  /**
   * Stable per-install random UUID identifying this connection. The gateway uses
   * it as the stale-connection dedupe key, so multiple channels on the same
   * physical device (same `deviceId`) coexist. Defaults to a fresh UUID, which
   * means a fresh dedupe identity per process — callers that want a reconnect to
   * replace its own previous socket should pass a persisted value.
   */
  connectionId?: string;
  /**
   * How long to wait for a connection to become fully authenticated before
   * abandoning it and retrying (default: 15s).
   */
  connectTimeoutMs?: number;
  deviceId?: string;
  gatewayUrl?: string;
  identityProvider?: GatewayIdentityProvider;
  logger?: GatewayClientLogger;
  serverUrl?: string;
  token: string;
  tokenType?: 'apiKey' | 'jwt' | 'serviceToken';
  /**
   * Serve HTTP tunnel requests: the gateway relays a browser request to a
   * loopback port on this machine (`http://127.0.0.1:<port>/…`) so a dev server
   * running here can be opened from the cloud UI. Default: enabled. Callers
   * that must never expose local ports can turn it off; the gateway then gets a
   * `TUNNEL_DISABLED` ack instead of silence.
   */
  tunnel?: boolean;
  userAgent?: string;
  userId?: string;
  /**
   * When set, the connection enrolls as a WORKSPACE-owned device: the gateway
   * routes it to the `workspace:<id>` principal (reachable by all members)
   * instead of the signer's personal one. The connect token must carry a
   * matching `workspace_id` claim or the gateway rejects the socket.
   */
  workspaceId?: string;
}

export class GatewayClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private detachSocket?: () => void;
  private authority?: GatewaySocketAuthority;
  private renewal?: GatewayIdentityRenewal;
  private identityProvider?: GatewayIdentityProvider;
  private dialController?: AbortController;
  private dialEpoch = 0;
  private expiryTimer?: ReturnType<typeof setInterval>;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectWatchdogTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = INITIAL_RECONNECT_DELAY;
  private missedHeartbeats = 0;
  private status: ConnectionStatus = 'disconnected';
  private pendingMetricAcks = new Map<
    string,
    { reject: (error: Error) => void; resolve: () => void }
  >();
  private intentionalDisconnect = false;
  /**
   * When each socket abandoned mid-handshake was abandoned. Only such a socket
   * can reach the gateway after its successor and knock it off with the
   * takeover reason: an opened socket was registered before the successor
   * existed. Each can do that at most once, and only within `connectTimeoutMs`
   * (the handshake budget), so a takeover consumes one live entry and anything
   * beyond them is another client.
   */
  private inFlightAbandons: number[] = [];
  private deviceId: string;
  private connectionId: string;
  private channel?: string;
  private gatewayUrl: string;
  private token: string;
  private tokenType?: 'apiKey' | 'jwt' | 'serviceToken';
  private userAgent?: string;
  private userId?: string;
  private workspaceId?: string;
  private serverUrl?: string;
  private logger: GatewayClientLogger;
  private autoReconnect: boolean;
  private connectTimeoutMs: number;

  constructor(options: GatewayClientOptions) {
    super();
    this.token = options.token;
    this.identityProvider = options.identityProvider;
    this.tokenType = options.tokenType;
    this.userAgent = options.userAgent;
    this.gatewayUrl = options.gatewayUrl || DEFAULT_GATEWAY_URL;
    this.deviceId = options.deviceId || randomUUID();
    this.connectionId = options.connectionId || randomUUID();
    this.channel = options.channel;
    this.serverUrl = options.serverUrl;
    this.userId = options.userId;
    this.workspaceId = options.workspaceId;
    this.logger = options.logger || noopLogger;
    this.autoReconnect = options.autoReconnect ?? true;
    this.connectTimeoutMs = options.connectTimeoutMs ?? CONNECT_TIMEOUT;
  }

  // ─── Public API ───

  get connectionStatus(): ConnectionStatus {
    return this.status;
  }

  get currentDeviceId(): string {
    return this.deviceId;
  }

  get currentConnectionId(): string {
    return this.connectionId;
  }

  override on<K extends keyof GatewayClientEvents>(
    event: K,
    listener: GatewayClientEvents[K],
  ): this {
    return super.on(event, listener);
  }

  override emit<K extends keyof GatewayClientEvents>(
    event: K,
    ...args: Parameters<GatewayClientEvents[K]>
  ): boolean {
    return super.emit(event, ...args);
  }

  /**
   * Update the auth token used for (re)connections.
   * Call this after refreshing an expired JWT, then call `reconnect()`.
   */
  updateToken(token: string): void {
    this.token = token;
  }

  /**
   * Force a reconnect cycle: close the current WebSocket and establish a new connection.
   * Useful after calling `updateToken()` with a fresh JWT.
   */
  async reconnect(): Promise<void> {
    this.cleanup();
    this.intentionalDisconnect = false;
    this.reconnectDelay = INITIAL_RECONNECT_DELAY;
    this.doConnect();
  }

  async connect(): Promise<void> {
    if (this.status === 'connected' || this.status === 'connecting') {
      return;
    }
    this.intentionalDisconnect = false;
    this.doConnect();
  }

  async disconnect(): Promise<void> {
    // Explicit log so a permanent stop (e.g. the auth_failed path calls
    // disconnect()) is provable from logs instead of inferred from the
    // absence of later reconnect lines.
    this.logger.info('Intentional disconnect; auto-reconnect disabled');
    this.intentionalDisconnect = true;
    this.cleanup();
    this.setStatus('disconnected');
  }

  sendToolCallResponse(response: Omit<ToolCallResponseMessage, 'type'>): void {
    this.sendMessage({
      ...response,
      type: 'tool_call_response',
    });
  }

  sendMessageApiResponse(response: Omit<MessageApiResponseMessage, 'type'>): void {
    this.sendMessage({
      ...response,
      type: 'message_api_response',
    });
  }

  /**
   * Push a batch of health samples to the gateway (its only store) and resolve
   * once the gateway acks it. Rejects when not connected, when the connection
   * drops mid-flight, or when no ack arrives in time — the caller keeps the
   * batch and retries later.
   */
  reportMetrics(_samples: DeviceMetricSample[]): Promise<void> {
    return Promise.reject(new Error('DEVICE_METRICS_UNSUPPORTED'));
  }

  sendSystemInfoResponse(response: Omit<SystemInfoResponseMessage, 'type'>): void {
    this.sendMessage({
      ...response,
      type: 'system_info_response',
    });
  }

  sendRpcResponse(response: Omit<RpcResponseMessage, 'type'>): void {
    this.sendMessage({
      ...response,
      type: 'rpc_response',
    });
  }

  sendAgentRunAck(response: Omit<AgentRunAckMessage, 'type'>): void {
    this.sendMessage({
      ...response,
      type: 'agent_run_ack',
    });
  }

  // ─── Connection Logic ───

  private async doConnect() {
    this.clearReconnectTimer();

    this.setStatus('connecting');
    this.renewal?.dispose();
    this.authority?.invalidate();
    this.dialController?.abort();
    const controller = new AbortController();
    this.dialController = controller;
    const epoch = ++this.dialEpoch;
    try {
      if (this.tokenType && this.tokenType !== 'jwt' && !this.identityProvider)
        throw new Error('SOURCE_UNVERIFIABLE');
      const identity = this.identityProvider
        ? await this.askIdentity({
            signal: controller.signal,
            renewAuthorizationId: this.authority?.identity.authorizationId,
          })
        : gatewayIdentityHint(this.token, 'urn:lobehub:gateway:device');
      if (controller.signal.aborted || epoch !== this.dialEpoch) return;
      assertGatewayIdentityContinuity(
        this.authority?.identity,
        identity,
        this.workspaceId
          ? { kind: 'workspace', id: this.workspaceId }
          : { kind: 'user', id: this.userId ?? identity.userId },
      );
      this.token = identity.gatewayTicket;
      this.tokenType = 'jwt';
      this.authority = new GatewaySocketAuthority(identity, 'urn:lobehub:gateway:device');
      const wsUrl = this.buildWsUrl();
      this.logger.debug(`Connecting to: ${wsUrl}`);

      // `handshakeTimeout` bounds TCP+TLS+upgrade inside `ws` itself, which turns
      // a black-holed handshake into a normal error/close pair. The watchdog
      // below is the belt to that suspenders: it also covers the phase `ws`
      // knows nothing about — an opened socket whose `auth_success` never lands.
      const wsOptions = {
        handshakeTimeout: this.connectTimeoutMs,
        ...(this.userAgent ? { headers: { 'User-Agent': this.userAgent } } : {}),
      };
      const ws = new WebSocket(wsUrl, wsOptions);

      this.detachSocket = attachGatewaySocket(ws, () => this.ws === ws, {
        open: this.handleOpen,
        message: this.handleMessage,
        close: this.handleClose,
        error: this.handleError,
      });

      this.ws = ws;
      this.renewal = new GatewayIdentityRenewal({
        authority: this.authority,
        provider: this.identityProvider && ((input) => this.askIdentity(input)),
        isCurrent: () => this.ws === ws && epoch === this.dialEpoch && !controller.signal.aborted,
        sendAuth: (next) =>
          this.sendMessage({
            type: 'auth',
            tenancyProtocol: 1,
            tokenType: 'jwt',
            token: next.gatewayTicket,
            serverUrl: this.serverUrl,
          }),
        onFailed: (code) => {
          void this.disconnect();
          this.emit('auth_failed', code);
        },
        onTemporary: (code) => {
          if (this.listenerCount('error')) this.emit('error', new Error(code));
        },
        onExpired: () => {
          this.cleanup();
          this.setStatus('authenticating');
          this.emit('auth_expired');
        },
      });
      this.startConnectWatchdog();
    } catch (error) {
      if (controller.signal.aborted || epoch !== this.dialEpoch) return;
      const failure = gatewayIdentityFailure(error);
      this.logger.error('Gateway identity connection failed:', failure.code);
      if (!failure.retryable) {
        await this.disconnect();
        this.emit('auth_failed', failure.code);
        return;
      }
      this.setStatus('disconnected');
      if (this.listenerCount('error')) this.emit('error', new Error(failure.code));
      if (this.autoReconnect) this.scheduleReconnect();
      else this.emit('disconnected');
    }
  }

  /** Work signs this client's own device and connection into the ticket; the URL values are only hints. */
  private askIdentity(input: Parameters<GatewayIdentityProvider>[0]) {
    return this.identityProvider!({
      ...input,
      connectionId: this.connectionId,
      deviceId: this.deviceId,
    });
  }

  private buildWsUrl(): string {
    const url = strictGatewayUrl(this.gatewayUrl, 'ws');
    url.protocol = ['https:', 'wss:'].includes(url.protocol) ? 'wss:' : 'ws:';
    const params = new URLSearchParams({
      connectionId: this.connectionId,
      deviceId: this.deviceId,
      hostname: os.hostname(),
      platform: process.platform,
    });

    if (this.channel) {
      params.set('channel', this.channel);
    }

    // Workspace device: route to the `workspace:<id>` principal. Otherwise the
    // personal path passes userId. (The DO re-validates the token's claim, so
    // the routing param alone grants nothing.)
    if (this.workspaceId) {
      params.set('workspaceId', this.workspaceId);
    } else if (this.userId) {
      params.set('userId', this.userId);
    }

    url.search = params.toString();
    return url.toString();
  }

  // ─── WebSocket Event Handlers ───

  private handleOpen = () => {
    this.logger.info(
      `WebSocket connected, sending auth... (${describeGatewayTokenExpiry(this.token)})`,
    );
    this.setStatus('authenticating');

    // Send token as first message instead of in URL
    this.sendMessage({
      tenancyProtocol: 1,
      serverUrl: this.serverUrl,
      token: this.token,
      tokenType: this.tokenType,
      type: 'auth',
    });
  };

  private handleMessage = (data: WebSocket.Data) => {
    try {
      const message = JSON.parse(String(data)) as ServerMessage;
      if (['auth_failed', 'tenant_unavailable', 'capability_failed'].includes(message.type)) {
        const failure = message as { code?: string; reason?: string };
        const code = failure.code ?? failure.reason ?? 'UNAUTHORIZED';
        if (gatewayIdentityFailure({ code }).retryable) this.forceReconnect(code);
        else {
          this.logger.error(`Authentication failed: ${code}`);
          void this.disconnect();
          this.emit('auth_failed', code);
        }
        return;
      }
      if (message.type === 'lease_update') {
        this.authority!.confirm(message);
        return;
      }
      if (
        !['auth_success', 'auth_failed', 'auth_expired'].includes(message.type) &&
        (this.status !== 'connected' || !this.authority?.alive())
      )
        return;
      if (
        [
          'tool_call_request',
          'system_info_request',
          'rpc_request',
          'message_api_request',
          'agent_run_request',
        ].includes(message.type)
      ) {
        assertDeviceCommandPayload(message);
        const frame = message as unknown as GatewayCommandBinding;
        this.authority!.admit(frame, frame.requestId!, 'device:respond');
        const authority = this.authority!;
        Object.assign(message, {
          executionSignal: authority.signal,
          isExecutionCurrent: () =>
            this.authority === authority && authority.alive('device:respond'),
        });
      }

      switch (message.type) {
        case 'auth_success': {
          const renewed = this.renewal!.confirm(message);
          this.authority = this.renewal!.authority;
          this.token = this.authority.identity.gatewayTicket;
          if (renewed) return;
          this.reconnectDelay = INITIAL_RECONNECT_DELAY;
          if (this.expiryTimer) clearInterval(this.expiryTimer);
          this.expiryTimer = setInterval(() => {
            if (!this.authority?.alive()) {
              this.cleanup();
              this.setStatus('authenticating');
              this.emit('auth_expired');
            }
          }, 250);
          this.logger.info('Authentication successful');
          this.clearConnectWatchdog();
          this.setStatus('connected');
          this.startHeartbeat();
          this.emit('connected');
          break;
        }

        case 'heartbeat_ack': {
          this.missedHeartbeats = 0;
          this.emit('heartbeat_ack');
          break;
        }

        case 'tool_call_request': {
          this.emit('tool_call_request', message as ToolCallRequestMessage);
          break;
        }

        case 'message_api_request': {
          this.emit('message_api_request', message as MessageApiRequestMessage);
          break;
        }

        case 'system_info_request': {
          this.emit('system_info_request', message as SystemInfoRequestMessage);
          break;
        }

        case 'rpc_request': {
          this.emit('rpc_request', message as RpcRequestMessage);
          break;
        }

        case 'agent_run_request': {
          this.emit('agent_run_request', message as AgentRunRequestMessage);
          break;
        }

        case 'auth_expired': {
          this.cleanup();
          this.setStatus('authenticating');
          this.logger.warn('Received auth_expired from gateway');
          this.emit('auth_expired');
          break;
        }

        default: {
          this.logger.warn('Unknown message type:', (message as any).type);
        }
      }
    } catch (error) {
      this.logger.error('Failed to parse WebSocket message:', error as string);
      this.authority?.invalidate();
      this.emit('auth_failed', gatewayIdentityFailure(error).code);
      void this.disconnect();
    }
  };

  private handleClose = (code: number, reason: Buffer) => {
    this.renewal?.dispose();
    if (this.expiryTimer) clearInterval(this.expiryTimer);
    this.logger.info(`WebSocket closed: code=${code} reason=${reason.toString()}`);
    this.stopHeartbeat();
    // In-flight tunnels can't survive the socket: their frames have nowhere to
    // go and the browser side is already being failed by the gateway.
    this.authority?.invalidate();
    this.rejectPendingMetricAcks();
    // `handshakeTimeout` closes the socket on its own, so the watchdog must be
    // disarmed here or it would fire later and force a SECOND reconnect on top
    // of the one this close already scheduled.
    this.clearConnectWatchdog();
    this.ws = null;

    if (
      !this.intentionalDisconnect &&
      reason.toString() === REPLACED_CLOSE_REASON &&
      !this.consumeInFlightAbandon()
    ) {
      // Another client holding our connectionId just took over. Reconnecting
      // would knock it off in turn: the two would trade the connection every
      // second, and each tool call would land on whichever connected last —
      // including a getCommandOutput sent to the process that never ran the
      // command. Newest wins; this one stays down.
      this.logger.warn(
        'Connection taken over by another client with the same connection id; not reconnecting',
      );
      this.setStatus('disconnected');
      this.emit('replaced');
      this.emit('disconnected');
      return;
    }

    if (!this.intentionalDisconnect && this.autoReconnect) {
      this.setStatus('reconnecting');
      this.scheduleReconnect();
    } else {
      this.setStatus('disconnected');
      this.emit('disconnected');
    }
  };

  /** Attribute a takeover to one of our own late sockets, if one can still land. */
  private consumeInFlightAbandon(): boolean {
    const now = Date.now();
    this.inFlightAbandons = this.inFlightAbandons.filter((at) => now - at <= this.connectTimeoutMs);
    return this.inFlightAbandons.shift() !== undefined;
  }

  private handleError = async (error: Error) => {
    const failure = gatewayIdentityFailure(error, true);
    if (!failure.retryable) {
      await this.disconnect();
      this.emit('auth_failed', failure.code);
      return;
    }
    this.logger.error('WebSocket error:', error.message);
    if (this.listenerCount('error')) this.emit('error', error);
  };

  // ─── Heartbeat ───

  private startHeartbeat() {
    this.stopHeartbeat();
    this.missedHeartbeats = 0;
    this.heartbeatTimer = setInterval(() => {
      this.missedHeartbeats++;
      if (this.missedHeartbeats > MAX_MISSED_HEARTBEATS) {
        this.forceReconnect(`Missed ${this.missedHeartbeats} heartbeat acks, forcing reconnect`);
        return;
      }
      this.sendMessage({ type: 'heartbeat' });
    }, HEARTBEAT_INTERVAL);
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // ─── Connect watchdog ───

  private startConnectWatchdog() {
    this.clearConnectWatchdog();
    this.connectWatchdogTimer = setTimeout(() => {
      this.connectWatchdogTimer = null;
      this.forceReconnect(
        `No authenticated connection within ${this.connectTimeoutMs}ms (status: ${this.status}), forcing reconnect`,
      );
    }, this.connectTimeoutMs);
  }

  private clearConnectWatchdog() {
    if (this.connectWatchdogTimer) {
      clearTimeout(this.connectWatchdogTimer);
      this.connectWatchdogTimer = null;
    }
  }

  /**
   * Abandon the current socket and drive the retry ourselves. `closeWebSocket`
   * detaches our listeners, so `handleClose` will NOT run — every forced path
   * has to schedule the next attempt itself or the client goes quiet for good.
   */
  private forceReconnect(reason: string) {
    this.logger.warn(reason);
    this.closeWebSocket();
    this.stopHeartbeat();
    this.clearConnectWatchdog();

    if (this.autoReconnect) {
      this.setStatus('reconnecting');
      this.scheduleReconnect();
    } else {
      this.setStatus('disconnected');
      this.emit('disconnected');
    }
  }

  // ─── Reconnection (exponential backoff) ───

  private scheduleReconnect() {
    this.clearReconnectTimer();

    const delay = this.reconnectDelay;
    this.logger.info(`Scheduling reconnect in ${delay}ms`);
    this.emit('reconnecting', delay);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.logger.info('Attempting reconnect');
      this.doConnect();
    }, delay);

    // Exponential backoff: 1s → 2s → 4s → 8s → ... → 30s
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY);
  }

  private clearReconnectTimer() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  // ─── Status ───

  private setStatus(status: ConnectionStatus) {
    if (this.status === status) return;

    this.status = status;
    this.emit('status_changed', status);
  }

  // ─── Helpers ───

  private sendMessage(data: ClientMessage) {
    if (data.type !== 'auth') {
      if (this.status !== 'connected' || !this.authority?.alive()) return;
      if (data.type !== 'heartbeat') {
        const result = data as unknown as GatewayCommandBinding;
        const binding = this.authority.response(result.requestId!, result.attemptId);
        if (!binding) return;
        data = { ...data, ...binding } as ClientMessage;
      }
    }
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  /** An ack can no longer arrive on this socket; fail the batches so the sampler retries. */
  private rejectPendingMetricAcks() {
    for (const pending of this.pendingMetricAcks.values()) {
      pending.reject(new Error('Gateway connection closed'));
    }
    this.pendingMetricAcks.clear();
  }

  private closeWebSocket() {
    this.renewal?.dispose();
    if (this.expiryTimer) clearInterval(this.expiryTimer);
    // Every teardown funnels through here — including `forceReconnect`, which
    // detaches `handleClose` — so tunnels must be released here or a forced
    // reconnect would leave loopback fetches running and slots consumed.
    this.authority?.invalidate();
    this.rejectPendingMetricAcks();
    if (!this.ws) {
      return;
    }
    const ws = this.ws;
    if (ws.readyState === WebSocket.CONNECTING) this.inFlightAbandons.push(Date.now());
    const suppressCloseError = (error: Error) => {
      this.logger.debug(`Ignoring WebSocket error during close: ${error.message}`);
    };
    const cleanupCloseErrorSuppression = () => {
      ws.off('close', cleanupCloseErrorSuppression);
      ws.off('error', suppressCloseError);
    };

    // Remove only listeners registered by this client.
    // Keep a temporary error handler while closing to avoid unhandled
    // "WebSocket was closed before the connection was established" errors.
    this.detachSocket?.();
    this.detachSocket = undefined;
    ws.on('error', suppressCloseError);
    ws.once('close', cleanupCloseErrorSuppression);

    try {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close(1000, 'Client disconnect');
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Failed to close WebSocket gracefully: ${errorMsg}`);
    }

    this.ws = null;
  }

  private cleanup() {
    this.renewal?.dispose();
    this.dialEpoch++;
    this.dialController?.abort();
    this.authority?.invalidate();
    if (this.expiryTimer) clearInterval(this.expiryTimer);
    this.stopHeartbeat();
    this.clearReconnectTimer();
    this.clearConnectWatchdog();
    this.closeWebSocket();
  }
}

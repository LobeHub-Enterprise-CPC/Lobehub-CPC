import { assertGatewayIdentityContinuity, gatewayIdentityFailure } from './identity';
import { GatewayIdentityRenewal } from './identityRenewal';
import { MirroredTerminalEchoGuard } from './mirroredTerminalEcho';
import type { GatewayCommandBinding } from './tenancy';
import { gatewayIdentityHint, GatewaySocketAuthority, strictGatewayUrl } from './tenancy';
import { isSessionTerminalEvent } from './terminalEvent';
import type {
  AgentStreamClientEvents,
  AgentStreamClientOptions,
  AgentStreamEvent,
  ClientMessage,
  ConnectionStatus,
  ServerMessage,
  ToolResultMessage,
} from './types';

// ─── Constants ───

const HEARTBEAT_INTERVAL = 30_000; // 30s
const INITIAL_RECONNECT_DELAY = 1000; // 1s
const MAX_RECONNECT_DELAY = 30_000; // 30s
const MAX_MISSED_HEARTBEATS = 3;
const RESUME_FLUSH_DELAY = 500; // 500ms debounce after last resume event

// ─── Typed Event Emitter (browser-compatible, no node:events) ───

type Listener = (...args: any[]) => void;

class TypedEmitter {
  private listeners = new Map<string, Set<Listener>>();

  on(event: string, listener: Listener): void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
  }

  off(event: string, listener: Listener): void {
    this.listeners.get(event)?.delete(listener);
  }

  protected emit(event: string, ...args: unknown[]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const listener of set) {
      try {
        listener(...args);
      } catch (error) {
        console.error(`[AgentStreamClient] Error in ${event} listener:`, error);
      }
    }
  }

  removeAllListeners(): void {
    this.listeners.clear();
  }
}

// ─── AgentStreamClient ───

/**
 * Browser-compatible WebSocket client for receiving Agent execution events
 * from the Agent Gateway. Supports auto-reconnect with event replay via lastEventId.
 *
 * Protocol reference: apps/cli/src/utils/agentStream.ts
 */
export class AgentStreamClient extends TypedEmitter {
  private ws: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = INITIAL_RECONNECT_DELAY;
  private missedHeartbeats = 0;
  private _status: ConnectionStatus = 'disconnected';
  private intentionalDisconnect = false;
  private lastEventId = '';
  private sessionEnded = false;
  private authority?: GatewaySocketAuthority;
  private renewal?: GatewayIdentityRenewal;
  private identityProvider?: AgentStreamClientOptions['identityProvider'];
  private dialController?: AbortController;
  private dialEpoch = 0;
  private expiryTimer?: ReturnType<typeof setInterval>;

  // Resume buffering: when reconnecting with empty lastEventId, buffer events
  // until resume replay completes, then deduplicate and emit in order.
  private resumeBuffer: Array<{ event: AgentStreamEvent; id?: string }> = [];
  private resumeMode = false;
  private resumeFlushTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly gatewayUrl: string;
  private readonly connectionId: string;
  private readonly operationId: string;
  private readonly autoReconnect: boolean;
  private readonly resumeOnConnect: boolean;
  private token: string;
  private readonly terminalEchoGuard: MirroredTerminalEchoGuard;

  constructor(options: AgentStreamClientOptions) {
    super();
    this.gatewayUrl = options.gatewayUrl;
    this.connectionId = options.connectionId || crypto.randomUUID();
    this.operationId = options.operationId;
    this.token = options.token;
    this.identityProvider = options.identityProvider;
    this.autoReconnect = options.autoReconnect ?? true;
    this.resumeOnConnect = options.resumeOnConnect ?? false;
    this.lastEventId = options.lastEventId ?? '';
    this.terminalEchoGuard = new MirroredTerminalEchoGuard(options.operationId);
  }

  // ─── Public API ───

  get connectionStatus(): ConnectionStatus {
    return this._status;
  }

  /**
   * Subscribe to typed events.
   */
  override on<K extends keyof AgentStreamClientEvents>(
    event: K,
    listener: AgentStreamClientEvents[K],
  ): void {
    super.on(event, listener as Listener);
  }

  /**
   * Unsubscribe from typed events.
   */
  override off<K extends keyof AgentStreamClientEvents>(
    event: K,
    listener: AgentStreamClientEvents[K],
  ): void {
    super.off(event, listener as Listener);
  }

  /**
   * Connect to the Agent Gateway WebSocket.
   */
  connect(): void {
    if (this._status === 'connected' || this._status === 'connecting') return;
    this.intentionalDisconnect = false;
    this.sessionEnded = false;
    this.doConnect();
  }

  /**
   * Disconnect and stop auto-reconnect.
   */
  disconnect(): void {
    this.intentionalDisconnect = true;
    this.cleanup();
    this.setStatus('disconnected');
    this.emit('disconnected');
  }

  /**
   * Send a tool execution result back to the server.
   * Correlated by toolCallId; the server's agent loop is blocked on BLPOP until this arrives.
   * Returns true when the payload was handed off to the WebSocket, false when no live socket
   * is available (caller should fall back to server-side BLPOP timeout).
   */
  sendToolResult(result: Omit<ToolResultMessage, 'type'>): boolean {
    const binding = this.authority?.response(result.toolCallId, result.attemptId);
    if (!binding) return false;
    return this.sendMessage({ ...result, ...binding, type: 'tool_result' });
  }

  sendToolConfirmation(toolCallId: string, attemptId: string, approved: boolean): boolean {
    const binding = this.authority?.response(toolCallId, attemptId);
    return !!binding && this.sendMessage({ ...binding, type: 'tool_confirmation', approved });
  }
  sendUserInput(requestId: string, attemptId: string, content: string): boolean {
    const binding = this.authority?.response(requestId, attemptId);
    return !!binding && this.sendMessage({ ...binding, type: 'user_input', content });
  }

  /**
   * Update the auth token used for (re)connections.
   * Call this after refreshing an expired JWT, then call `reconnect()`.
   */
  updateToken(token: string): void {
    this.token = token;
  }

  /**
   * Force a reconnect cycle: tear down the current WebSocket and establish a
   * fresh connection (which will re-authenticate with the latest token).
   * Use this after `updateToken()` to recover from `auth_expired`.
   */
  async reconnect(): Promise<void> {
    this.cleanup();
    this.intentionalDisconnect = false;
    this.sessionEnded = false;
    this.reconnectDelay = INITIAL_RECONNECT_DELAY;
    this.doConnect();
  }

  // ─── Connection Logic ───

  private async doConnect(): Promise<void> {
    this.clearReconnectTimer();
    this.setStatus('connecting');
    this.renewal?.dispose();
    this.authority?.invalidate();
    this.dialController?.abort();
    const controller = new AbortController();
    this.dialController = controller;
    const epoch = ++this.dialEpoch;

    try {
      const identity = this.identityProvider
        ? await this.askIdentity({
            signal: controller.signal,
            renewAuthorizationId: this.authority?.identity.authorizationId,
          })
        : gatewayIdentityHint(this.token, 'urn:lobehub:gateway:agent', this.operationId);
      if (controller.signal.aborted || epoch !== this.dialEpoch) return;
      assertGatewayIdentityContinuity(this.authority?.identity, identity);
      this.token = identity.gatewayTicket;
      this.authority = new GatewaySocketAuthority(
        identity,
        'urn:lobehub:gateway:agent',
        this.operationId,
      );
      const wsUrl = this.buildWsUrl();
      const ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        if (this.ws === ws) this.handleOpen();
      };
      ws.onmessage = (event) => {
        if (this.ws === ws) this.handleMessage(event);
      };
      ws.onclose = () => {
        if (this.ws === ws) this.handleClose();
      };
      ws.onerror = () => {
        if (this.ws === ws) this.handleError();
      };

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
          }),
        onFailed: (code) => {
          this.disconnect();
          this.emit('auth_failed', code);
        },
        onTemporary: (code) => {
          this.emit('error', new Error(code));
        },
        onExpired: () => {
          this.cleanup();
          this.setStatus('authenticating');
          this.emit('auth_expired');
        },
      });
    } catch (error) {
      if (controller.signal.aborted || epoch !== this.dialEpoch) return;
      const failure = gatewayIdentityFailure(error);
      console.error('[AgentStreamClient] Gateway identity connection failed:', failure.code);
      if (!failure.retryable) {
        this.disconnect();
        this.emit('auth_failed', failure.code);
        return;
      }
      this.setStatus('disconnected');
      this.emit('error', new Error(failure.code));
      if (this.autoReconnect && !this.sessionEnded) this.scheduleReconnect();
      else this.emit('disconnected');
    }
  }

  /** Offer Work this client's own connection id to sign into the ticket (the URL repeats it as a hint). */
  private askIdentity(input: Parameters<NonNullable<typeof this.identityProvider>>[0]) {
    return this.identityProvider!({ ...input, connectionId: this.connectionId });
  }

  private buildWsUrl(): string {
    const url = strictGatewayUrl(this.gatewayUrl, 'ws');
    url.protocol = ['https:', 'wss:'].includes(url.protocol) ? 'wss:' : 'ws:';
    url.searchParams.set('operationId', this.operationId);
    url.searchParams.set('connectionId', this.connectionId);
    return url.toString();
  }

  // ─── WebSocket Event Handlers ───

  private handleOpen = (): void => {
    this.setStatus('authenticating');
    this.sendMessage({
      token: this.token,
      tenancyProtocol: 1,
      tokenType: 'jwt',
      type: 'auth',
    });
  };

  private handleMessage = (event: MessageEvent): void => {
    try {
      let message = JSON.parse(event.data as string) as ServerMessage;
      if (['auth_failed', 'tenant_unavailable', 'capability_failed'].includes(message.type)) {
        const failure = message as { code?: string; reason?: string };
        this.handleGatewayFailure(failure.code ?? failure.reason ?? 'UNAUTHORIZED');
        return;
      }
      const directTool = message.type === 'tool_execute';
      if (directTool) {
        const frame = message as GatewayCommandBinding & { data: unknown };
        if (this._status !== 'connected') return;
        const business = frame.data as Record<string, unknown>;
        if (
          !business ||
          typeof business.identifier !== 'string' ||
          typeof business.apiName !== 'string' ||
          typeof business.arguments !== 'string' ||
          typeof business.executionTimeoutMs !== 'number'
        )
          throw new Error('INVALID_GATEWAY_MESSAGE');
        message = {
          type: 'agent_event',
          event: {
            type: 'tool_execute',
            operationId: frame.operationId!,
            timestamp: Date.now(),
            stepIndex: 0,
            data: { ...business, ...frame, data: undefined },
          },
        };
      }
      if (message.type === 'tool_confirmation_request' || message.type === 'input_request') {
        if (this._status !== 'connected') return;
        this.authority!.admit(message, message.toolCallId ?? message.requestId!, 'agent:respond');
        this.emit(message.type, message);
        return;
      }
      if (message.type === 'lease_update') {
        this.authority!.confirm(message);
        return;
      }
      if (
        !['auth_success', 'auth_failed', 'auth_expired'].includes(message.type) &&
        (this._status !== 'connected' || !this.authority?.alive())
      )
        return;

      switch (message.type) {
        case 'auth_success': {
          const renewed = this.renewal!.confirm(message);
          this.authority = this.renewal!.authority;
          this.token = this.authority.identity.gatewayTicket;
          if (renewed) return;
          this.reconnectDelay = INITIAL_RECONNECT_DELAY;
          this.setStatus('connected');
          if (this.expiryTimer) clearInterval(this.expiryTimer);
          this.expiryTimer = setInterval(() => {
            if (!this.authority?.alive()) {
              this.cleanup();
              this.setStatus('authenticating');
              this.emit('auth_expired');
            }
          }, 250);
          this.startHeartbeat();

          // Enter resume mode only for explicit reconnect scenarios (page reload).
          // Buffer all events until resume replay completes, then deduplicate and emit.
          // This is NOT enabled for normal first-connect to avoid delaying live streaming.
          //
          // The replay is terminated by an authoritative `resume_complete` (the
          // DO's stored status, which survives hibernation) — that message is
          // what exits resume mode and decides completion. We deliberately do
          // NOT arm a timeout to guess completion from silence: an empty replay
          // no longer means "finished" (the DO may simply have hibernated its
          // event buffer), and guessing was exactly the multi-device
          // false-cancel bug. If `resume_complete` never arrives (e.g. a
          // rolled-back DO that predates the authoritative resume_complete fix), we just keep waiting — a
          // safe, recoverable state, with heartbeat loss still forcing reconnect
          // — instead of cancelling a live run.
          if (this.resumeOnConnect && !this.lastEventId) {
            this.resumeMode = true;
            this.resumeBuffer = [];
          }

          // Request all buffered events (covers events pushed before WS connected).
          // `wantStatus` opts into the authoritative `resume_complete` reply
          // this client knows how to consume it, so a current
          // gateway will hand back the real session status. Legacy gateways
          // ignore the flag and just replay — we then rely on live events, never
          // guessing completion from silence.
          this.terminalEchoGuard.beginReplay();
          this.sendMessage({ lastEventId: this.lastEventId, type: 'resume', wantStatus: true });
          this.emit('connected');
          break;
        }

        case 'auth_expired': {
          this.cleanup();
          this.setStatus('authenticating');
          // Token expired but the server kept the socket open. Don't disconnect —
          // the listener will refresh the token and call `reconnect()`.
          this.emit('auth_expired');
          break;
        }

        case 'heartbeat_ack': {
          this.missedHeartbeats = 0;
          break;
        }

        case 'agent_event': {
          const agentEvent: AgentStreamEvent = message.event;
          if (agentEvent.type === 'llm_execute' || agentEvent.type === 'llm_cancel')
            throw new Error('LLM_RELAY_UNSUPPORTED');
          if (agentEvent.type === 'tool_execute') {
            if (!directTool) throw new Error('INVALID_GATEWAY_MESSAGE');
            const frame = {
              ...(agentEvent.data as object),
              operationId: agentEvent.operationId,
              type: 'tool_execute',
            } as unknown as GatewayCommandBinding;
            this.authority!.admit(frame, frame.toolCallId!, 'agent:execute');
            const authority = this.authority!;
            Object.assign(agentEvent.data as object, {
              executionSignal: authority.signal,
              isExecutionCurrent: () =>
                this.authority === authority && authority.alive('agent:execute'),
            });
          }
          if (message.id) this.lastEventId = message.id;
          this.terminalEchoGuard.observe(agentEvent);

          // A single WebSocket is multiplexed: alongside this op's events it may
          // carry forwarded events from other operations (e.g. broadcast council
          // members mirrored onto the supervisor's channel). A terminal event
          // ends the SESSION only when it belongs to THIS op — a member
          // finishing must not disconnect the supervisor's socket and stop
          // sibling/supervisor streaming. Events with no operationId (legacy
          // gateway) are treated as this op's, preserving old behavior.
          const isOwnTerminal =
            isSessionTerminalEvent(agentEvent) &&
            (!agentEvent.operationId || agentEvent.operationId === this.operationId);

          if (this.resumeMode) {
            // Buffer events during resume — will be deduplicated and emitted after replay
            this.resumeBuffer.push({ event: agentEvent, id: message.id });
            this.scheduleResumeFlush();

            // Only this op's terminal ends the session (even in resume mode).
            if (isOwnTerminal) {
              this.sessionEnded = true;
              this.flushResumeBuffer();
              this.disconnect();
            }
            break;
          }

          this.emit('agent_event', agentEvent);

          // This op's terminal — session is done, no need to reconnect. A
          // forwarded member terminal is still emitted above (so its handler can
          // finalize that member) but must NOT tear down this connection.
          if (isOwnTerminal) {
            this.sessionEnded = true;
            this.disconnect();
          }
          break;
        }

        case 'resume_complete': {
          // Authoritative status from the DO, sent right after resume replay
          // — this is the definitive end-of-replay marker, so
          // cancel the pending debounce flush and act on it immediately.
          if (this.resumeFlushTimer) {
            clearTimeout(this.resumeFlushTimer);
            this.resumeFlushTimer = null;
          }

          // Emit any events buffered during resume, in order, before deciding.
          if (this.resumeMode) {
            this.flushResumeBuffer();
          }

          const terminal =
            (message.status === 'completed' ||
              message.status === 'error' ||
              message.status === 'interrupted') &&
            // A status left by a mirrored member's terminal, not this op's end.
            !this.terminalEchoGuard.isStaleResumeStatus(message.status);

          if (terminal) {
            this.sessionEnded = true;
            this.emit('session_complete', {
              source: 'resume_status',
              status: message.status,
            });
            this.disconnect();
          }
          // Non-terminal (running / waiting_input / waiting_confirmation): the
          // run is alive. Stay connected and keep streaming live events — do NOT
          // fire session_complete. This is the core fix: a fresh subscriber on a
          // hibernated DO no longer false-completes and clears runningOperation.
          break;
        }

        case 'session_complete': {
          // A member's mirrored terminal, echoed back as the end of THIS
          // session by gateways that end on any `agent_runtime_end`.
          if (this.terminalEchoGuard.consumeEcho('session_complete')) break;
          this.sessionEnded = true;
          // Flush any buffered resume events before disconnecting
          if (this.resumeMode) {
            this.flushResumeBuffer();
          }
          this.emit('session_complete', { source: 'raw_session_complete' });
          this.disconnect();
          break;
        }
      }
    } catch (error) {
      console.error('[AgentStreamClient] Failed to parse message:', error);
      this.authority?.invalidate();
      this.emit('auth_failed', error instanceof Error ? error.message : 'INVALID_GATEWAY_MESSAGE');
      this.disconnect();
    }
  };

  private handleGatewayFailure(code: string): void {
    if (!gatewayIdentityFailure({ code }).retryable) {
      this.disconnect();
      this.emit('auth_failed', code);
      return;
    }
    this.cleanup();
    if (!this.intentionalDisconnect && this.autoReconnect && !this.sessionEnded) {
      this.setStatus('reconnecting');
      this.scheduleReconnect();
    } else {
      this.setStatus('disconnected');
      this.emit('disconnected');
    }
    this.emit('error', new Error(code));
  }

  private handleClose = (): void => {
    this.renewal?.dispose();
    if (this.expiryTimer) clearInterval(this.expiryTimer);
    this.authority?.invalidate();
    this.stopHeartbeat();
    this.ws = null;

    if (!this.intentionalDisconnect && this.autoReconnect && !this.sessionEnded) {
      this.setStatus('reconnecting');
      this.scheduleReconnect();
    } else if (this._status !== 'disconnected') {
      this.setStatus('disconnected');
      this.emit('disconnected');
    }
  };

  private handleError = (): void => {
    // The close event will follow; just emit the error
    this.emit('error', new Error(`WebSocket error for operation ${this.operationId}`));
  };

  // ─── Heartbeat ───

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.missedHeartbeats = 0;
    this.heartbeatTimer = setInterval(() => {
      this.missedHeartbeats++;
      if (this.missedHeartbeats > MAX_MISSED_HEARTBEATS) {
        console.error(
          `[AgentStreamClient] Missed ${this.missedHeartbeats} heartbeat acks, forcing reconnect`,
        );
        this.closeWebSocket();
        this.stopHeartbeat();
        if (this.autoReconnect && !this.sessionEnded) {
          this.setStatus('reconnecting');
          this.scheduleReconnect();
        } else {
          this.setStatus('disconnected');
          this.emit('disconnected');
        }
        return;
      }
      this.sendMessage({ type: 'heartbeat' });
    }, HEARTBEAT_INTERVAL);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // ─── Reconnection (exponential backoff) ───

  private scheduleReconnect(): void {
    this.clearReconnectTimer();

    const delay = this.reconnectDelay;
    this.emit('reconnecting', delay);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.doConnect();
    }, delay);

    // Exponential backoff: 1s → 2s → 4s → ... → 30s
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  // ─── Status ───

  private setStatus(status: ConnectionStatus): void {
    if (this._status === status) return;
    this._status = status;
    this.emit('status_changed', status);
  }

  // ─── Resume Buffering ───

  /**
   * Schedule a debounced flush of the resume buffer.
   * Resume replay events arrive in rapid succession; once there's a 500ms gap,
   * we consider the replay done and flush the deduplicated buffer.
   */
  private scheduleResumeFlush(): void {
    if (this.resumeFlushTimer) clearTimeout(this.resumeFlushTimer);
    this.resumeFlushTimer = setTimeout(() => {
      this.flushResumeBuffer();
    }, RESUME_FLUSH_DELAY);
  }

  /**
   * Deduplicate buffered events by event ID and emit them in order.
   */
  private flushResumeBuffer(): void {
    if (!this.resumeMode) return;
    this.resumeMode = false;

    if (this.resumeFlushTimer) {
      clearTimeout(this.resumeFlushTimer);
      this.resumeFlushTimer = null;
    }

    // Deduplicate by event ID, keeping the first occurrence (from resume replay)
    const seen = new Set<string>();
    const deduped: AgentStreamEvent[] = [];

    for (const { event, id } of this.resumeBuffer) {
      const key = id || `${event.type}_${event.stepIndex}_${event.timestamp}`;
      if (!seen.has(key)) {
        seen.add(key);
        deduped.push(event);
      }
    }

    this.resumeBuffer = [];

    // Emit deduplicated events in order
    for (const event of deduped) {
      this.emit('agent_event', event);
    }
  }

  // ─── Helpers ───

  private sendMessage(data: ClientMessage): boolean {
    if (data.type !== 'auth' && (this._status !== 'connected' || !this.authority?.alive()))
      return false;
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
      return true;
    }
    return false;
  }

  private closeWebSocket(): void {
    this.renewal?.dispose();
    if (this.expiryTimer) clearInterval(this.expiryTimer);
    if (this.ws) {
      // Remove handlers to prevent handleClose from firing after manual close
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onclose = null;
      this.ws.onerror = null;

      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close(1000, 'Client disconnect');
      }
      this.ws = null;
    }
  }

  private cleanup(): void {
    this.renewal?.dispose();
    this.dialEpoch++;
    this.dialController?.abort();
    this.authority?.invalidate();
    if (this.expiryTimer) clearInterval(this.expiryTimer);
    this.stopHeartbeat();
    this.clearReconnectTimer();
    this.closeWebSocket();
    if (this.resumeFlushTimer) {
      clearTimeout(this.resumeFlushTimer);
      this.resumeFlushTimer = null;
    }
    this.resumeMode = false;
    this.resumeBuffer = [];
  }
}

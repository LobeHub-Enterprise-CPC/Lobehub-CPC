import { toRecord } from '@lobechat/utils/object';

import type { GatewayIdentityResponse } from '../../types/src/gateway';
import { gatewayCloseFailure, gatewayIdentityFailure } from './identity';
import { GatewayIdentityRenewal } from './identityRenewal';
import type { GatewayMuxClient } from './mux/GatewayMuxClient';
import type { OperationSubscriptionEvents } from './mux/types';
import type { GatewayCommandBinding } from './tenancy';
import {
  gatewayIdentityHint,
  GatewaySocketAuthority,
  gatewayTicketClaims,
  strictGatewayUrl,
} from './tenancy';
import type { AgentStreamEvent } from './types';

const AUDIENCE = 'urn:lobehub:gateway:agent';

interface TenancyMuxOptions {
  clientId: string;
  createWebSocket?: (url: string) => WebSocket;
  gatewayUrl: string;
  issueToken: (input: { clientId: string; authorizationId?: string }) => Promise<{ token: string }>;
  tenantId?: string;
  userId?: string;
}

/** Outer transport only: the upstream mux never consumes tickets or tenancy authority. */
export const createTenancyMuxTransport = (options: TenancyMuxOptions) => {
  let terminal: string | undefined;
  let current: TenancyMuxSocket | undefined;
  let pinned: GatewayIdentityResponse | undefined;
  // Upstream confirmation/input APIs carry only a request ID. Never let a
  // later attempt reuse that ID and capture a delayed response from the first.
  const responseRequests = new Set<string>();
  const identityFrom = (token: string) => {
    const identity = gatewayIdentityHint(token, AUDIENCE);
    const claims = gatewayTicketClaims(token);
    if (
      claims.connectionId !== options.clientId ||
      claims.deviceId ||
      identity.principal.kind !== 'user' ||
      identity.principal.id !== identity.userId ||
      (options.tenantId && identity.tenantId !== options.tenantId) ||
      (options.userId && identity.userId !== options.userId)
    )
      throw new Error('UNAUTHORIZED');
    if (pinned && (pinned.tenantId !== identity.tenantId || pinned.userId !== identity.userId))
      throw new Error('TENANT_MISMATCH');
    pinned ??= identity;
    return identity;
  };
  return {
    bindMux: (mux: GatewayMuxClient) => {
      const subscribe = mux.subscribe.bind(mux);
      mux.subscribe = (...args) => {
        const subscription = subscribe(...args);
        const on = subscription.on.bind(subscription);
        subscription.on = (event, listener) => {
          if (event !== 'agent_event') return on(event, listener);
          return on('agent_event', (value: AgentStreamEvent) => {
            current?.decorateEvent(value);
            (listener as OperationSubscriptionEvents['agent_event'])(value);
          });
        };
        return subscription;
      };
    },
    getToken: async () => {
      if (terminal) throw new Error(terminal);
      try {
        const { token } = await options.issueToken({ clientId: options.clientId });
        identityFrom(token);
        return token;
      } catch (error) {
        const failure = gatewayIdentityFailure(error);
        if (!failure.retryable) terminal = failure.code;
        throw new Error(failure.code, { cause: error });
      }
    },
    createWebSocket: (upstreamUrl: string): WebSocket => {
      if (!URL.canParse(upstreamUrl)) throw new Error('GATEWAY_TENANCY_UNSUPPORTED');
      const url = new URL(upstreamUrl);
      const token = url.searchParams.get('token') ?? '';
      if (url.searchParams.get('clientId') !== options.clientId) throw new Error('UNAUTHORIZED');
      const identity = identityFrom(token);
      const target = strictGatewayUrl(options.gatewayUrl, 'v2/ws');
      target.protocol = target.protocol === 'https:' || target.protocol === 'wss:' ? 'wss:' : 'ws:';
      target.searchParams.set('clientId', options.clientId);
      current = new TenancyMuxSocket(
        (options.createWebSocket ?? ((address) => new WebSocket(address)))(target.toString()),
        identity,
        responseRequests,
        async (authorizationId) => {
          const result = await options.issueToken({ clientId: options.clientId, authorizationId });
          return identityFrom(result.token);
        },
        (code) => {
          terminal = code;
        },
      );
      return current as unknown as WebSocket;
    },
  };
};

/** The small browser socket surface used by GatewayMuxClient. */
class TenancyMuxSocket {
  onopen: WebSocket['onopen'] = null;
  onmessage: WebSocket['onmessage'] = null;
  onclose: WebSocket['onclose'] = null;
  onerror: WebSocket['onerror'] = null;
  readyState = 0;
  private closed = false;
  private authenticated = false;
  private readonly renewal: GatewayIdentityRenewal;
  private expiry?: ReturnType<typeof setInterval>;
  private readonly subscriptions = new Map<string, boolean>();
  private readonly seen = new Set<string>();
  private readonly pending = new Map<string, GatewayCommandBinding>();
  private readonly responseTypes = new Map<string, string>();
  private get authority() {
    return this.renewal.authority;
  }

  constructor(
    private readonly socket: WebSocket,
    identity: GatewayIdentityResponse,
    private readonly responseRequests: Set<string>,
    renew: (authorizationId: string) => Promise<GatewayIdentityResponse>,
    private readonly onTerminal: (code: string) => void,
  ) {
    this.renewal = new GatewayIdentityRenewal({
      authority: new GatewaySocketAuthority(identity, AUDIENCE),
      isCurrent: () => !this.closed,
      onExpired: () => this.fail('LEASE_EXPIRED'),
      onFailed: (code) => this.fail(code),
      onTemporary: () => {},
      provider: ({ renewAuthorizationId }) => renew(renewAuthorizationId!),
      sendAuth: (next) => this.auth(next.gatewayTicket),
    });
    socket.onopen = () => {
      if (!this.closed) this.auth(identity.gatewayTicket);
    };
    socket.onmessage = (event) => this.receive(event);
    socket.onclose = (event) => {
      if (this.closed) return;
      const failure = gatewayCloseFailure(event.code, event.reason);
      if (failure) return this.fail(failure);
      this.finish(event.code, event.reason);
    };
    socket.onerror = (event) => {
      // Browsers hide upgrade status; their following close spends the mux dial budget.
      const failure = gatewayIdentityFailure(event, true);
      if (!failure.retryable) this.fail(failure.code);
      else this.onerror?.call(this.facade, event);
    };
  }

  private get facade() {
    return this as unknown as WebSocket;
  }
  private auth(token: string) {
    this.socket.send(JSON.stringify({ type: 'auth', tenancyProtocol: 1, tokenType: 'jwt', token }));
  }
  private fail(code: string) {
    if (this.closed) return;
    if (!gatewayIdentityFailure({ code }).retryable) this.onTerminal(code);
    // 4401 asks the upstream mux to reacquire a ticket. For terminal errors the
    // transport's getToken rejects locally, spending its existing dial budget.
    this.finish(4401, code);
    this.socket.close(1000);
  }
  private finish(code: number, reason = '') {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    clearInterval(this.expiry);
    this.renewal.dispose();
    this.authority.invalidate();
    this.pending.clear();
    this.responseTypes.clear();
    this.onclose?.call(this.facade, { code, reason } as CloseEvent);
  }
  close(code = 1000, reason = '') {
    this.finish(code, reason);
    this.socket.close(code, reason);
  }

  send(data: string) {
    if (!this.authenticated || !this.authority.alive()) return this.fail('LEASE_EXPIRED');
    const frame = toRecord(JSON.parse(data));
    if (!frame) return this.fail('INVALID_GATEWAY_MESSAGE');
    const operationId = String(frame.operationId ?? '');
    if (frame.type === 'subscribe') this.subscriptions.set(operationId, frame.executor === true);
    if (frame.type === 'unsubscribe') {
      this.subscriptions.delete(operationId);
      for (const [key, binding] of this.pending) {
        if (binding.operationId === operationId) {
          this.pending.delete(key);
          this.responseTypes.delete(key);
          this.authority.pending.delete(key);
        }
      }
    }
    if (['tool_result', 'tool_confirmation', 'user_input'].includes(String(frame.type))) {
      const key = JSON.stringify([operationId, frame.toolCallId ?? frame.requestId]);
      const pending = this.pending.get(key);
      const attemptId =
        typeof frame.attemptId === 'string'
          ? frame.attemptId
          : frame.type === 'tool_result'
            ? undefined
            : pending?.attemptId;
      if (
        !pending ||
        pending.operationId !== operationId ||
        this.responseTypes.get(key) !== frame.type
      )
        return;
      const binding = this.authority.response(key, attemptId);
      if (!binding) return;
      this.pending.delete(key);
      this.responseTypes.delete(key);
      this.socket.send(JSON.stringify({ ...frame, ...binding }));
      return;
    }
    this.socket.send(data);
  }

  private receive(event: MessageEvent) {
    if (this.closed) return;
    try {
      const frame = toRecord(JSON.parse(event.data));
      if (!frame) throw new Error('INVALID_GATEWAY_MESSAGE');
      const type = String(frame.type);
      if (
        ['auth_failed', 'auth_expired', 'tenant_unavailable', 'capability_failed'].includes(type)
      ) {
        return this.fail(String(frame.code ?? 'UNAUTHORIZED'));
      }
      if (type === 'auth_success' || type === 'lease_update') {
        if (type === 'auth_success') this.renewal.confirm(frame);
        else this.authority.confirm(frame);
        if (!this.authenticated) {
          this.authenticated = true;
          this.readyState = 1;
          this.onopen?.call(this.facade, new Event('open'));
          this.expiry = setInterval(() => {
            if (!this.authority.alive()) this.fail('LEASE_EXPIRED');
          }, 250);
        }
        return;
      }
      if (!this.authenticated) return;
      if (!this.authority.alive()) return this.fail('LEASE_EXPIRED');
      if (frame.tenancyProtocol !== 1 || frame.tenantId !== this.authority.identity.tenantId)
        throw new Error('TENANT_MISMATCH');
      if (frame.connectionGeneration !== this.authority.connectionGeneration)
        throw new Error('UNAUTHORIZED');
      if (
        [
          'agent_event',
          'status_change',
          'session_complete',
          'resume_complete',
          'op_lifecycle',
          'heartbeat_ack',
        ].includes(type) &&
        frame.sourceAcceptedVersion === undefined
      )
        throw new Error('TENANT_EXECUTION_VERSION_REQUIRED');
      if (
        frame.sourceAcceptedVersion !== undefined &&
        frame.sourceAcceptedVersion !== this.authority.identity.acceptedVersion
      )
        throw new Error('TENANT_EXECUTION_VERSION_STALE');
      const nested = toRecord(frame.event);
      if (
        ['llm_execute', 'llm_cancel', 'llm-execute', 'llm-cancel', 'llm-close'].includes(type) ||
        ['llm_execute', 'llm_cancel'].includes(String(nested?.type))
      )
        throw new Error('LLM_RELAY_UNSUPPORTED');
      if (nested?.type === 'tool_execute') throw new Error('INVALID_GATEWAY_MESSAGE');
      if (
        type === 'ready' &&
        (frame.protocol !== 2 ||
          frame.userId !== this.authority.identity.userId ||
          frame.connectionId !==
            gatewayTicketClaims(this.authority.identity.gatewayTicket).connectionId)
      )
        throw new Error('UNAUTHORIZED');
      if (['tool_execute', 'tool_confirmation_request', 'input_request'].includes(type)) {
        const operationId = typeof frame.operationId === 'string' ? frame.operationId : '';
        const commandId = type === 'input_request' ? frame.requestId : frame.toolCallId;
        if (typeof commandId !== 'string' || !commandId) throw new Error('INVALID_GATEWAY_MESSAGE');
        if (
          !operationId ||
          !this.subscriptions.has(operationId) ||
          (type === 'tool_execute' && !this.subscriptions.get(operationId))
        )
          throw new Error('FORBIDDEN');
        const key = JSON.stringify([operationId, commandId]);
        const seenKey = JSON.stringify([key, frame.attemptId]);
        if (this.seen.has(seenKey) || (type !== 'tool_execute' && this.responseRequests.has(key)))
          throw new Error('ATTEMPT_CONFLICT');
        const authority = this.authority;
        authority.admit(
          frame as unknown as GatewayCommandBinding,
          key,
          type === 'tool_execute' ? 'agent:execute' : 'agent:respond',
        );
        this.seen.add(seenKey);
        if (type !== 'tool_execute') this.responseRequests.add(key);
        this.responseTypes.set(
          key,
          type === 'tool_execute'
            ? 'tool_result'
            : type === 'input_request'
              ? 'user_input'
              : 'tool_confirmation',
        );
        this.pending.set(key, frame as unknown as GatewayCommandBinding);
        if (type === 'tool_execute') {
          const business = toRecord(frame.data);
          if (
            !business ||
            typeof business.identifier !== 'string' ||
            typeof business.apiName !== 'string' ||
            typeof business.arguments !== 'string' ||
            typeof business.executionTimeoutMs !== 'number'
          )
            throw new Error('INVALID_GATEWAY_MESSAGE');
          const data = { ...business, ...frame, data: undefined };
          // The outer subscription decorator restores local execution guards after mux parsing.
          const converted = {
            ...frame,
            type: 'agent_event',
            event: {
              type: 'tool_execute',
              operationId,
              timestamp: Date.now(),
              stepIndex: 0,
              data,
            },
          };
          this.deliver(converted);
          return;
        }
      }
      this.onmessage?.call(this.facade, event);
    } catch (error) {
      this.fail(gatewayIdentityFailure(error).code);
    }
  }

  decorateEvent(event: AgentStreamEvent) {
    if (event.type !== 'tool_execute') return;
    const data = toRecord(event.data);
    if (!data) return;
    const key = JSON.stringify([event.operationId, data.toolCallId]);
    const binding = this.pending.get(key);
    const authority = this.authority;
    const admitted =
      binding?.attemptId === data.attemptId &&
      binding?.connectionGeneration === authority.connectionGeneration;
    Object.assign(data, {
      executionSignal: authority.signal,
      isExecutionCurrent: () =>
        admitted &&
        this.authority === authority &&
        this.subscriptions.get(event.operationId) === true &&
        authority.alive('agent:execute'),
    });
  }

  private deliver(frame: unknown) {
    this.onmessage?.call(this.facade, { data: JSON.stringify(frame) } as MessageEvent);
  }
}

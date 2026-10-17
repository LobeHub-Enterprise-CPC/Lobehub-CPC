import type {
  GatewayAudience,
  GatewayCapability,
  GatewayIdentityResponse,
} from '../../types/src/gateway';

export const GATEWAY_CLOCK_SKEW_MS = 250;

export type GatewayConfirmation = {
  type: 'auth_success' | 'lease_update';
  tenancyProtocol: 1;
  tenantId: string;
  principal: GatewayIdentityResponse['principal'];
  audience: GatewayAudience;
  roles: GatewayCapability[];
  acceptedVersion: number;
  connectionGeneration: number;
  ticketExpiresAt: number;
  authRecordExpiresAt: number;
  leaseExpiresAt: number;
};
export type GatewayCommandBinding = {
  tenancyProtocol: 1;
  tenantId: string;
  sourceAcceptedVersion: number;
  attemptId: string;
  connectionGeneration: number;
  operationId?: string;
  toolCallId?: string;
  requestId?: string;
};
const fail = (code = 'INVALID_GATEWAY_MESSAGE'): never => {
  throw new Error(code);
};
const positive = (n: unknown): n is number =>
  typeof n === 'number' && Number.isSafeInteger(n) && n > 0;
const text = (s: unknown): s is string => typeof s === 'string' && s.length > 0;
export const strictGatewayUrl = (base: string, path: string) => {
  const url = new URL(base);
  if (
    !['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    return fail('GATEWAY_TENANCY_UNSUPPORTED');
  url.pathname = `${url.pathname.replace(/\/+$/, '').replace(/\/tenant\/v1$/, '')}/tenant/v1/${path.replace(/^\/+/, '')}`;
  return url;
};

/** Claims here are connection hints only. Work and the gateway verify the actual signed ticket. */
export const gatewayIdentityHint = (
  ticket: string,
  audience: GatewayAudience,
  operationId?: string,
): GatewayIdentityResponse => {
  try {
    const encoded = ticket.split('.')[1]?.replaceAll('-', '+').replaceAll('_', '/');
    const claims = JSON.parse(atob(encoded));
    if (
      claims.iss !== 'urn:lobehub:gateway-session' ||
      claims.purpose !== 'gateway-connect' ||
      claims.aud !== audience ||
      !text(claims.tid) ||
      !text(claims.sub) ||
      !positive(claims.accepted_version) ||
      claims.operation_id !== operationId ||
      !text(claims.authorization_id) ||
      !positive(claims.exp)
    )
      return fail();
    const identity: GatewayIdentityResponse = {
      tenancyProtocol: 1,
      tenantId: claims.tid,
      userId: claims.sub,
      principal: claims.principal,
      capabilities: claims.capabilities,
      acceptedVersion: claims.accepted_version,
      authorizationId: claims.authorization_id,
      gatewayTicket: ticket,
      ticketExpiresAt: claims.exp * 1000,
      authRecordExpiresAt: claims.exp * 1000,
    };
    validateGatewayIdentity(identity, audience);
    return identity;
  } catch {
    return fail('GATEWAY_TENANCY_UNSUPPORTED');
  }
};
export const validateGatewayIdentity = (
  identity: GatewayIdentityResponse,
  audience: GatewayAudience,
) => {
  const roles = audience.endsWith(':agent')
    ? ['agent:observe', 'agent:respond', 'agent:execute']
    : ['device:connect', 'device:respond'];
  if (
    identity.tenancyProtocol !== 1 ||
    !/^[\w.:-]{1,128}$/.test(identity.tenantId) ||
    !text(identity.userId) ||
    !text(identity.authorizationId) ||
    !text(identity.gatewayTicket) ||
    !['user', 'workspace'].includes(identity.principal?.kind) ||
    !text(identity.principal?.id) ||
    !positive(identity.acceptedVersion) ||
    !positive(identity.ticketExpiresAt) ||
    !positive(identity.authRecordExpiresAt) ||
    !Array.isArray(identity.capabilities) ||
    !identity.capabilities.length ||
    identity.capabilities.some((r) => !roles.includes(r))
  )
    fail();
};

/** No ambient tenant state. Each instance belongs to one concrete authenticated socket. */
export class GatewaySocketAuthority {
  private readonly controller = new AbortController();
  get signal() {
    return this.controller.signal;
  }
  private confirmation?: GatewayConfirmation;
  get connectionGeneration() {
    return this.confirmation?.connectionGeneration;
  }
  get identityDeadline() {
    return Math.min(
      this.identity.ticketExpiresAt,
      this.identity.authRecordExpiresAt,
      this.confirmation?.ticketExpiresAt ?? Infinity,
      this.confirmation?.authRecordExpiresAt ?? Infinity,
    );
  }
  private deadline = 0;
  private wall = Date.now();
  private monotonic = performance.now();
  private readonly startedAt = performance.now();
  private invalid = false;
  readonly pending = new Map<string, GatewayCommandBinding>();
  constructor(
    readonly identity: GatewayIdentityResponse,
    readonly audience: GatewayAudience,
    readonly operationId?: string,
  ) {
    validateGatewayIdentity(identity, audience);
  }
  confirm(raw: unknown): void {
    const frame = raw as GatewayConfirmation;
    if (
      !frame ||
      !['auth_success', 'lease_update'].includes(frame.type) ||
      frame.tenancyProtocol !== 1 ||
      typeof frame.tenantId !== 'string' ||
      !/^[\w.:-]{1,128}$/.test(frame.tenantId) ||
      !['urn:lobehub:gateway:agent', 'urn:lobehub:gateway:device'].includes(frame.audience) ||
      !['user', 'workspace'].includes(frame.principal?.kind) ||
      !text(frame.principal?.id) ||
      !positive(frame.acceptedVersion) ||
      !positive(frame.connectionGeneration) ||
      !Array.isArray(frame.roles) ||
      !frame.roles.length ||
      new Set(frame.roles).size !== frame.roles.length ||
      ![frame.ticketExpiresAt, frame.authRecordExpiresAt, frame.leaseExpiresAt].every(positive)
    )
      return this.deny('INVALID_GATEWAY_MESSAGE');
    if (frame.tenantId !== this.identity.tenantId) return this.deny('TENANT_MISMATCH');
    if (
      frame.audience !== this.audience ||
      frame.principal.kind !== this.identity.principal.kind ||
      frame.principal.id !== this.identity.principal.id
    )
      return this.deny('UNAUTHORIZED');
    if (frame.acceptedVersion !== this.identity.acceptedVersion)
      return this.deny('TENANT_EXECUTION_VERSION_STALE');
    if (frame.roles.some((role) => !this.identity.capabilities.includes(role)))
      return this.deny('FORBIDDEN');
    if (this.invalid || !this.clockContinuous()) return this.deny();
    if (frame.type === 'lease_update' && !this.confirmation) return this.deny('UNAUTHORIZED');
    if (this.confirmation) {
      if (
        frame.type === 'auth_success' ||
        frame.connectionGeneration !== this.confirmation.connectionGeneration
      )
        return this.deny('UNAUTHORIZED');
      if (!this.alive()) return this.deny();
    }
    const now = performance.now();
    const remaining = Math.min(
      30_000,
      frame.leaseExpiresAt - Date.now() - GATEWAY_CLOCK_SKEW_MS,
      frame.ticketExpiresAt - Date.now() - GATEWAY_CLOCK_SKEW_MS,
      frame.authRecordExpiresAt - Date.now() - GATEWAY_CLOCK_SKEW_MS,
      this.identity.ticketExpiresAt - Date.now() - GATEWAY_CLOCK_SKEW_MS,
      this.identity.authRecordExpiresAt - Date.now() - GATEWAY_CLOCK_SKEW_MS,
      frame.type === 'auth_success' ? this.startedAt + 30_000 - now : 30_000,
    );
    if (remaining <= 0) return this.deny();
    this.confirmation = frame;
    this.deadline = now + remaining;
    this.wall = Date.now();
    this.monotonic = now;
  }
  alive(role?: GatewayCapability): boolean {
    if (
      this.invalid ||
      !this.confirmation ||
      !this.clockContinuous() ||
      performance.now() >= this.deadline ||
      Date.now() + GATEWAY_CLOCK_SKEW_MS >=
        Math.min(
          this.confirmation.leaseExpiresAt,
          this.confirmation.ticketExpiresAt,
          this.confirmation.authRecordExpiresAt,
          this.identity.ticketExpiresAt,
          this.identity.authRecordExpiresAt,
        )
    ) {
      this.invalidate();
      return false;
    }
    return !role || this.confirmation.roles.includes(role);
  }
  admit(frame: GatewayCommandBinding, key: string, role: GatewayCapability): void {
    if (this.alive() && !this.alive(role)) return this.deny('FORBIDDEN');
    if (
      !this.alive(role) ||
      !text(key) ||
      frame.tenancyProtocol !== 1 ||
      frame.tenantId !== this.identity.tenantId ||
      frame.sourceAcceptedVersion !== this.identity.acceptedVersion ||
      frame.connectionGeneration !== this.confirmation!.connectionGeneration ||
      !text(frame.attemptId) ||
      (this.operationId && frame.operationId !== this.operationId) ||
      this.pending.has(key)
    )
      return this.deny();
    this.pending.set(key, {
      tenancyProtocol: 1,
      tenantId: frame.tenantId,
      sourceAcceptedVersion: frame.sourceAcceptedVersion,
      attemptId: frame.attemptId,
      connectionGeneration: frame.connectionGeneration,
      ...(frame.operationId ? { operationId: frame.operationId } : {}),
      ...(frame.toolCallId ? { toolCallId: frame.toolCallId } : {}),
      ...(frame.requestId ? { requestId: frame.requestId } : {}),
    });
  }
  response(key: string, attemptId?: string): GatewayCommandBinding | undefined {
    if (!this.alive()) return;
    const binding = this.pending.get(key);
    if (!binding || !attemptId || binding.attemptId !== attemptId) return;
    this.pending.delete(key);
    return binding;
  }
  invalidate() {
    this.invalid = true;
    this.confirmation = undefined;
    this.pending.clear();
    this.controller.abort();
  }
  private clockContinuous() {
    const wallDelta = Date.now() - this.wall,
      monoDelta = performance.now() - this.monotonic;
    return (
      wallDelta >= 0 && monoDelta >= 0 && Math.abs(wallDelta - monoDelta) <= GATEWAY_CLOCK_SKEW_MS
    );
  }
  private deny(code = 'LEASE_EXPIRED'): never {
    this.invalidate();
    return fail(code);
  }
}

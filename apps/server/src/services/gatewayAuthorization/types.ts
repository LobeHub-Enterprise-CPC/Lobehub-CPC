import type {
  GatewayAudience,
  GatewayDispatchBinding,
  GatewayDispatchResult,
  GatewayExecutionContext,
  GatewayExecutionIntent,
  GatewayIdentityResponse,
  GatewayPrincipal,
} from '@lobechat/types';

export type GatewayAuthorizationSource =
  | { kind: 'session'; sessionId: string; subject: string }
  | { kind: 'apiKey'; keyId: string; keyHash: string; subject: string; workspaceId?: string }
  | { kind: 'oidc'; jti: string; subject: string }
  | { kind: 'operation'; operationId: string; subject: string };
export type {
  GatewayAudience,
  GatewayCapability,
  GatewayDispatchBinding,
  GatewayDispatchResult,
  GatewayExecutionAction,
  GatewayExecutionContext,
  GatewayExecutionIntent,
  GatewayIdentityResponse,
  GatewayPrincipal,
} from '@lobechat/types';
export interface GatewayLifecycleContext {
  acceptedVersion: number;
  eventId: string;
  tenantId: string;
}
export interface GatewayAuthorizationRecord extends Omit<
  GatewayIdentityResponse,
  'gatewayTicket' | 'tenancyProtocol'
> {
  audience: GatewayAudience;
  /** Signed into the ticket for the device audience (and optionally for agents); see `mintGatewayTicket`. */
  connectionId?: string;
  deviceId?: string;
  jti: string;
  operationId?: string;
  source: GatewayAuthorizationSource;
}
export interface GatewayOIDCProjection {
  accessTokenExpiresAt: number;
  boundSessionUid?: string;
  clientAuthority: 'static' | 'database';
  clientId: string;
  grantId: string;
  issuer: string;
  subject: string;
  tenantId: string;
}
export type GatewayAttemptOutcome =
  'cancelledBeforeDispatch' | 'interrupted' | 'executionUnknown' | 'completed';
export interface GatewayAttemptRecord {
  dispatchBinding?: GatewayDispatchBinding;
  dispatchResult?: GatewayDispatchResult;
  intent: GatewayExecutionIntent;
  result?: GatewayCallback;
  source: GatewayAuthorizationSource;
  state: 'prepared' | 'claimed' | GatewayAttemptOutcome;
}
export interface GatewayAuthorizeRequest {
  action: 'connect' | 'renew' | 'dispatch' | 'result';
  attemptId?: string;
  audience: GatewayAudience;
  authorizationId: string;
  dispatchBinding?: GatewayDispatchBinding;
  expectedPrincipal: GatewayPrincipal;
  generation: number;
  operationId?: string;
  requestSeq: number;
  sourceAcceptedVersion?: number;
  tenancyProtocol: 1;
  tenantId: string;
  ticket?: string;
}
export interface GatewayCallback extends GatewayExecutionContext {
  attemptId: string;
  dispatchBinding: GatewayDispatchBinding;
  operationId: string;
  outcome: GatewayAttemptOutcome;
  result?: unknown;
  tenancyProtocol: 1;
  toolCallId: string;
}
export type GatewayFinalizeRequest = GatewayExecutionContext & {
  tenancyProtocol: 1;
  operationId: string;
} & (
    | { kind: 'executor-attempt'; attemptId: string; dispatchBinding: GatewayDispatchBinding }
    | {
        kind: 'operation-watchdog';
        ownerPrincipal: GatewayPrincipal;
        watchdog: { lastEventAt: number; firedAt: number };
      }
  );

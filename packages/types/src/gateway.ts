export type GatewayAudience = 'urn:lobehub:gateway:agent' | 'urn:lobehub:gateway:device';
export interface GatewayPrincipal {
  id: string;
  kind: 'user' | 'workspace';
}
export type GatewayCapability =
  'agent:observe' | 'agent:respond' | 'agent:execute' | 'device:connect' | 'device:respond';
export interface GatewayExecutionContext {
  readonly sourceAcceptedVersion: number;
  readonly tenantId: string;
}
export type GatewayExecutionEnvelope = GatewayExecutionContext;
export interface GatewayDispatchBinding {
  authorizationId: string;
  connectionGeneration: number;
  connectionId: string;
}
export type GatewayExecutionAction =
  | 'operations.init'
  | 'operations.push-event'
  | 'operations.push-events'
  | 'operations.update-status'
  | 'operations.request-confirmation'
  | 'operations.request-input'
  | 'operations.tool-execute'
  | 'device.tool-call'
  | 'device.system-info'
  | 'device.rpc'
  | 'device.message-api'
  | 'device.agent/run';
export interface GatewayExecutionIntent extends GatewayExecutionContext {
  action: GatewayExecutionAction;
  actor: { subject: string; sourceRef: string };
  attemptExpiresAt: number;
  attemptId: string;
  operationId?: string;
  resourceId: string;
  targetPrincipal: GatewayPrincipal;
  tenancyProtocol: 1;
  toolCallId?: string;
}
export interface GatewayDispatchEnvelope extends GatewayExecutionEnvelope {
  intent: GatewayExecutionIntent;
}
/** Existing synchronous Device dispatch-result wire envelope. */
export interface GatewayDispatchResult extends GatewayExecutionContext {
  attemptId: string;
  dispatchBinding: GatewayDispatchBinding;
  operationId?: string;
  outcome: 'cancelledBeforeDispatch' | 'interrupted' | 'executionUnknown' | 'completed';
  result?: unknown;
  toolCallId?: string;
}
export interface GatewayIdentityResponse {
  acceptedVersion: number;
  authorizationId: string;
  authRecordExpiresAt: number;
  capabilities: GatewayCapability[];
  gatewayTicket: string;
  principal: GatewayPrincipal;
  tenancyProtocol: 1;
  tenantId: string;
  ticketExpiresAt: number;
  userId: string;
}
export interface GatewayIdentityRequest {
  audience: GatewayAudience;
  operationId?: string;
  renewAuthorizationId?: string;
  tenancyProtocol: 1;
  workspaceId?: string;
}
export type GatewayIdentityProvider = (input: {
  signal: AbortSignal;
  /**
   * The socket the identity is for. Work signs it into the ticket (device: required,
   * agent: optional); the gateway uses that value, never what the URL says.
   */
  connectionId?: string;
  /** The device the client claims to host. Device audience only; Work decides whether it may. */
  deviceId?: string;
  renewAuthorizationId?: string;
}) => Promise<GatewayIdentityResponse>;

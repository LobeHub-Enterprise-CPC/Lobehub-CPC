import { randomUUID } from 'node:crypto';

import { requireTenantScope } from '@lobechat/database/tenant';

import { signGatewayJWT } from '@/libs/trpc/utils/gatewayJwt';
import { getTenantRuntime } from '@/server/modules/Tenant/runtime';
import { redisService } from '@/server/services/redis';

import { operationGatewaySource } from './context';
import { requireOriginalGatewayAuthorization } from './renewal';
import { assertGatewaySource } from './sources';
import type {
  GatewayAudience,
  GatewayAuthorizationSource,
  GatewayCapability,
  GatewayIdentityResponse,
  GatewayPrincipal,
} from './types';
import { GatewayAuthorizationError } from './wire';

export const assertGatewayVersion = async (tenantId: string, version: number) => {
  if (!Number.isInteger(version) || version < 1)
    throw new GatewayAuthorizationError('TENANT_EXECUTION_VERSION_REQUIRED', 400);
  const scope = requireTenantScope();
  if (scope.tenantId !== tenantId || scope.acceptedVersion !== version)
    throw new GatewayAuthorizationError('TENANT_EXECUTION_VERSION_STALE', 409);
  const admission = await getTenantRuntime().gatewayAdmission(tenantId);
  if (admission.effectiveState !== 'active')
    throw new GatewayAuthorizationError(`TENANT_${admission.effectiveState.toUpperCase()}`, 403);
  if (admission.acceptedVersion !== version)
    throw new GatewayAuthorizationError('TENANT_EXECUTION_VERSION_STALE', 409);
  return admission;
};
export const mintGatewayTicket = async (input: {
  source: GatewayAuthorizationSource;
  audience: GatewayAudience;
  principal: GatewayPrincipal;
  operationId?: string;
  capabilities: GatewayCapability[];
  renewAuthorizationId?: string;
}): Promise<GatewayIdentityResponse> => {
  const scope = requireTenantScope();
  const startedAt = Date.now();
  await assertGatewayVersion(scope.tenantId, scope.acceptedVersion);
  const agent = input.audience === 'urn:lobehub:gateway:agent';
  if (agent && !input.operationId) throw new GatewayAuthorizationError('MUX_UNSUPPORTED', 501);
  const allowed: GatewayCapability[] = agent
    ? ['agent:observe', 'agent:respond', 'agent:execute']
    : ['device:connect', 'device:respond'];
  const capabilities = [...new Set(input.capabilities)];
  if (!capabilities.length || !capabilities.every((capability) => allowed.includes(capability)))
    throw new GatewayAuthorizationError('FORBIDDEN', 403);
  const previous =
    input.renewAuthorizationId !== undefined
      ? await requireOriginalGatewayAuthorization({
          ...input,
          renewAuthorizationId: input.renewAuthorizationId,
          capabilities,
        })
      : undefined;
  let sourceExpiresAt: number;
  try {
    sourceExpiresAt = await assertGatewaySource(input.source, {
      principal: input.principal,
      operationId: input.operationId,
      enroller: !agent,
      execute: capabilities.includes('agent:execute') || capabilities.includes('agent:respond'),
    });
  } catch (error) {
    if (previous && error instanceof GatewayAuthorizationError && error.status < 500)
      throw new GatewayAuthorizationError('SOURCE_UNVERIFIABLE');
    throw error;
  }
  const now = Math.floor(startedAt / 1000);
  const ticketExpiresAt = Math.min(now + 300, Math.floor(sourceExpiresAt / 1000)) * 1000;
  if (ticketExpiresAt <= Date.now())
    throw new GatewayAuthorizationError(previous ? 'SOURCE_UNVERIFIABLE' : 'UNAUTHORIZED');
  const authorizationId = previous?.authorizationId ?? randomUUID();
  const jti = randomUUID();
  const record = {
    tenantId: scope.tenantId,
    userId: input.source.subject,
    principal: input.principal,
    audience: input.audience,
    capabilities,
    authorizationId,
    acceptedVersion: scope.acceptedVersion,
    ticketExpiresAt,
    authRecordExpiresAt: ticketExpiresAt,
    source: input.source,
    operationId: input.operationId,
    jti,
  };
  const gatewayTicket = await signGatewayJWT({
    iss: 'urn:lobehub:gateway-session',
    aud: input.audience,
    purpose: 'gateway-connect',
    tid: scope.tenantId,
    sub: input.source.subject,
    principal: input.principal,
    authorization_id: authorizationId,
    accepted_version: scope.acceptedVersion,
    capabilities,
    jti,
    iat: now,
    exp: ticketExpiresAt / 1000,
    ...(input.operationId ? { operation_id: input.operationId } : {}),
  });
  if (previous) await redisService.gatewayAuthorization.renewAuthorization(previous, record);
  else await redisService.gatewayAuthorization.putAuthorization(authorizationId, record);
  return {
    tenancyProtocol: 1,
    tenantId: record.tenantId,
    userId: record.userId,
    principal: record.principal,
    capabilities,
    authorizationId,
    acceptedVersion: record.acceptedVersion,
    gatewayTicket,
    ticketExpiresAt,
    authRecordExpiresAt: record.authRecordExpiresAt,
  };
};

export const mintOperationGatewayTicket = async (
  userId: string,
  operationId: string,
  _workspaceId?: string | null,
  originalAuthorizationId?: string,
) => {
  const source = operationGatewaySource(userId, operationId);
  const identity = await mintGatewayTicket({
    source,
    audience: 'urn:lobehub:gateway:agent',
    principal: { kind: 'user', id: userId },
    operationId,
    capabilities: ['agent:observe', 'agent:respond', 'agent:execute'],
    renewAuthorizationId: originalAuthorizationId,
  });
  return identity.gatewayTicket;
};

import { requireTenantScope } from '@lobechat/database/tenant';

import { verifyGatewayJWT } from '@/libs/trpc/utils/gatewayJwt';
import { redisService } from '@/server/services/redis';

import { claimGatewayAttempt, loadGatewayAttempt, sameBinding } from './attempts';
import { assertGatewayVersion } from './index';
import { assertGatewaySource } from './sources';
import type { GatewayAuthorizeRequest } from './types';
import { GatewayAuthorizationError, samePrincipal } from './wire';

export const authorizeGateway = async (input: GatewayAuthorizeRequest) => {
  const checkedAt = Date.now();
  const scope = requireTenantScope();
  if (input.tenantId !== scope.tenantId)
    throw new GatewayAuthorizationError('TENANT_MISMATCH', 403);
  const record = await redisService.gatewayAuthorization.getAuthorization(input.authorizationId);
  if (
    !record ||
    record.tenantId !== input.tenantId ||
    record.audience !== input.audience ||
    record.operationId !== input.operationId ||
    !samePrincipal(record.principal, input.expectedPrincipal)
  )
    throw new GatewayAuthorizationError('UNAUTHORIZED');
  if (Math.min(record.ticketExpiresAt, record.authRecordExpiresAt) <= checkedAt)
    throw new GatewayAuthorizationError('LEASE_EXPIRED');
  let ticketExpiresAt = record.ticketExpiresAt;
  await assertGatewayVersion(input.tenantId, record.acceptedVersion);
  const sourceExpiresAt = await assertGatewaySource(record.source, {
    principal: record.principal,
    operationId: record.operationId,
    enroller: record.audience === 'urn:lobehub:gateway:device',
    execute:
      record.capabilities.includes('agent:execute') ||
      record.capabilities.includes('agent:respond'),
  });
  if (input.action === 'connect' || input.action === 'renew') {
    if (!input.ticket) throw new GatewayAuthorizationError('UNAUTHORIZED');
    const claims = await verifyGatewayJWT(input.ticket, input.audience, input.tenantId);
    if (
      claims.authorization_id !== record.authorizationId ||
      (input.action === 'connect' && claims.jti !== record.jti) ||
      claims.sub !== record.userId ||
      claims.accepted_version !== record.acceptedVersion ||
      claims.operation_id !== record.operationId ||
      JSON.stringify(claims.capabilities) !== JSON.stringify(record.capabilities) ||
      !samePrincipal(claims.principal as typeof record.principal, record.principal)
    )
      throw new GatewayAuthorizationError('UNAUTHORIZED');
    // An existing socket can revalidate while its same-source replacement ticket is
    // in flight. Its signed old ticket retains only its own original expiry.
    ticketExpiresAt = Number(claims.exp) * 1000;
    if (ticketExpiresAt <= checkedAt) throw new GatewayAuthorizationError('LEASE_EXPIRED');
  } else {
    if (
      !input.attemptId ||
      !input.dispatchBinding ||
      input.sourceAcceptedVersion !== record.acceptedVersion ||
      input.dispatchBinding.authorizationId !== input.authorizationId ||
      input.generation !== input.dispatchBinding.connectionGeneration
    )
      throw new GatewayAuthorizationError('ATTEMPT_CONFLICT', 409);
    const attempt = await loadGatewayAttempt(
      input.attemptId,
      { tenantId: input.tenantId, sourceAcceptedVersion: input.sourceAcceptedVersion },
      input.dispatchBinding,
      input.operationId,
    );
    const role =
      input.audience === 'urn:lobehub:gateway:agent'
        ? attempt.intent.action === 'operations.tool-execute'
          ? 'agent:execute'
          : 'agent:respond'
        : 'device:respond';
    if (!record.capabilities.includes(role)) throw new GatewayAuthorizationError('FORBIDDEN', 403);
    if (input.action === 'dispatch') await claimGatewayAttempt(attempt, input.dispatchBinding);
    else if (
      !sameBinding(attempt.dispatchBinding, input.dispatchBinding) ||
      attempt.state !== 'claimed'
    )
      throw new GatewayAuthorizationError('ATTEMPT_CONFLICT', 409);
  }
  const leaseExpiresAt = Math.min(
    checkedAt + 30_000,
    sourceExpiresAt,
    ticketExpiresAt,
    record.authRecordExpiresAt,
  );
  if (leaseExpiresAt <= Date.now()) throw new GatewayAuthorizationError('LEASE_EXPIRED');
  return {
    tenantId: input.tenantId,
    authorizationId: input.authorizationId,
    principal: record.principal,
    audience: record.audience,
    action: input.action,
    ...(input.operationId ? { operationId: input.operationId } : {}),
    acceptedVersion: record.acceptedVersion,
    ticketExpiresAt,
    authRecordExpiresAt: record.authRecordExpiresAt,
    leaseExpiresAt,
    checkedAt,
    generation: input.generation,
    requestSeq: input.requestSeq,
    ...(['dispatch', 'result'].includes(input.action)
      ? {
          sourceAcceptedVersion: input.sourceAcceptedVersion,
          attemptId: input.attemptId,
          dispatchBinding: input.dispatchBinding,
        }
      : {}),
  };
};

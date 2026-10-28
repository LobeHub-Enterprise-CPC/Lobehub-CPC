import { requireTenantScope } from '@lobechat/database/tenant';

import { redisService } from '@/server/services/redis';

import type {
  GatewayAudience,
  GatewayAuthorizationSource,
  GatewayCapability,
  GatewayPrincipal,
} from './types';
import { GatewayAuthorizationError, samePrincipal } from './wire';

export const requireOriginalGatewayAuthorization = async (input: {
  renewAuthorizationId: string;
  source: GatewayAuthorizationSource;
  principal: GatewayPrincipal;
  audience: GatewayAudience;
  operationId?: string;
  capabilities: GatewayCapability[];
  connectionId?: string;
  deviceId?: string;
}) => {
  const scope = requireTenantScope();
  const record = await redisService.gatewayAuthorization.getAuthorization(
    input.renewAuthorizationId,
  );
  const sameSource =
    record &&
    [record.source, input.source].every((source, index) =>
      Object.entries(source).every(
        ([key, value]) =>
          ([input.source, record.source][index] as Record<string, unknown>)[key] === value,
      ),
    );
  if (
    !record ||
    !sameSource ||
    record.authorizationId !== input.renewAuthorizationId ||
    record.tenantId !== scope.tenantId ||
    record.userId !== input.source.subject ||
    record.acceptedVersion !== scope.acceptedVersion ||
    record.audience !== input.audience ||
    record.operationId !== input.operationId ||
    record.deviceId !== input.deviceId ||
    record.connectionId !== input.connectionId ||
    !samePrincipal(record.principal, input.principal) ||
    Math.min(record.authRecordExpiresAt, record.ticketExpiresAt) <= Date.now() ||
    record.capabilities.length !== input.capabilities.length ||
    input.capabilities.some((capability) => !record.capabilities.includes(capability))
  )
    throw new GatewayAuthorizationError('SOURCE_UNVERIFIABLE');
  return record;
};

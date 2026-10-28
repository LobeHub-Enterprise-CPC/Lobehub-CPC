import type { GatewayIdentityResponse } from '@lobechat/agent-gateway-client';

/** Only the Work HTTP boundary is substituted; stream tests use the real G5 client. */
export const streamTestIdentityProvider =
  (_auth: unknown, options: { operationId: string }) => async () => {
    const exp = Math.floor(Date.now() / 1000) + 300;
    const claims = {
      iss: 'urn:lobehub:gateway-session',
      purpose: 'gateway-connect',
      aud: 'urn:lobehub:gateway:agent',
      tid: 'tenant-A',
      sub: 'test-user',
      principal: { kind: 'user' as const, id: 'test-user' },
      capabilities: ['agent:observe'] as GatewayIdentityResponse['capabilities'],
      operation_id: options.operationId,
      authorization_id: 'stream-source',
      accepted_version: 7,
      exp,
    };
    return {
      tenancyProtocol: 1 as const,
      tenantId: claims.tid,
      userId: claims.sub,
      principal: claims.principal,
      capabilities: claims.capabilities,
      authorizationId: claims.authorization_id,
      acceptedVersion: 7,
      gatewayTicket: `TEST.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.TEST`,
      ticketExpiresAt: exp * 1000,
      authRecordExpiresAt: exp * 1000,
    };
  };
export const streamTestConfirmation = (ticket: string) => {
  const claims = JSON.parse(Buffer.from(ticket.split('.')[1], 'base64url').toString('utf8'));
  return {
    type: 'auth_success',
    tenancyProtocol: 1,
    tenantId: claims.tid,
    principal: claims.principal,
    audience: claims.aud,
    roles: claims.capabilities,
    acceptedVersion: 7,
    connectionGeneration: 1,
    ticketExpiresAt: claims.exp * 1000,
    authRecordExpiresAt: claims.exp * 1000,
    leaseExpiresAt: Date.now() + 30_000,
  };
};

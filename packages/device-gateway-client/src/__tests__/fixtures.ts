export const deviceTicket = (authorizationId = 'test-auth', workspaceId?: string) =>
  `TEST.${btoa(JSON.stringify({ iss: 'urn:lobehub:gateway-session', purpose: 'gateway-connect', aud: 'urn:lobehub:gateway:device', tid: 'tenant-test', sub: 'test-user', principal: { kind: workspaceId ? 'workspace' : 'user', id: workspaceId ?? 'test-user' }, capabilities: ['device:connect', 'device:respond'], accepted_version: 1, authorization_id: authorizationId, exp: Math.floor(Date.now() / 1000) + 300 }))}.TEST`;
export const deviceConfirmation = () => ({
  type: 'auth_success',
  tenancyProtocol: 1,
  tenantId: 'tenant-test',
  principal: { kind: 'user', id: 'test-user' },
  audience: 'urn:lobehub:gateway:device',
  roles: ['device:connect', 'device:respond'],
  acceptedVersion: 1,
  connectionGeneration: 1,
  ticketExpiresAt: Date.now() + 300_000,
  authRecordExpiresAt: Date.now() + 300_000,
  leaseExpiresAt: Date.now() + 30_000,
});

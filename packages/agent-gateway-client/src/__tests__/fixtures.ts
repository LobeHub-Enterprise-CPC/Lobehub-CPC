export const testTicket = (operationId = 'op-123', authorizationId = 'test-auth') =>
  `TEST.${btoa(JSON.stringify({ iss: 'urn:lobehub:gateway-session', purpose: 'gateway-connect', aud: 'urn:lobehub:gateway:agent', tid: 'tenant-test', sub: 'test-user', principal: { kind: 'user', id: 'test-user' }, capabilities: ['agent:observe', 'agent:respond', 'agent:execute'], accepted_version: 1, authorization_id: authorizationId, operation_id: operationId, exp: Math.floor(Date.now() / 1000) + 300 }))}.TEST`;
export const testConfirmation = () => ({
  type: 'auth_success',
  tenancyProtocol: 1,
  tenantId: 'tenant-test',
  principal: { kind: 'user', id: 'test-user' },
  audience: 'urn:lobehub:gateway:agent',
  roles: ['agent:observe', 'agent:respond', 'agent:execute'],
  acceptedVersion: 1,
  connectionGeneration: 1,
  ticketExpiresAt: Date.now() + 300_000,
  authRecordExpiresAt: Date.now() + 300_000,
  leaseExpiresAt: Date.now() + 30_000,
});
export const testToolCommand = (toolCallId: string) => ({
  type: 'tool_execute',
  tenancyProtocol: 1,
  tenantId: 'tenant-test',
  sourceAcceptedVersion: 1,
  attemptId: 'attempt-test',
  connectionGeneration: 1,
  operationId: 'op-123',
  toolCallId,
  data: {
    toolCallId,
    identifier: 'test',
    apiName: 'run',
    arguments: '{}',
    executionTimeoutMs: 10_000,
  },
});

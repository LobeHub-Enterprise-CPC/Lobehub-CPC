import type { IncomingMessage, ServerResponse } from 'node:http';

interface DeviceIdentityInput {
  connectionId?: string;
  deviceId?: string;
  workspaceId?: string;
}

export const deviceGatewayTestIdentity = (input: DeviceIdentityInput) => {
  const exp = Math.floor(Date.now() / 1000) + 300;
  const principal = input.workspaceId
    ? { id: input.workspaceId, kind: 'workspace' }
    : { id: 'test-user', kind: 'user' };
  const claims = {
    accepted_version: 7,
    aud: 'urn:lobehub:gateway:device',
    authorization_id: 'connect-fixture',
    capabilities: ['device:connect', 'device:respond'],
    connection_id: input.connectionId,
    device_id: input.deviceId,
    exp,
    iss: 'urn:lobehub:gateway-session',
    principal,
    purpose: 'gateway-connect',
    sub: 'test-user',
    tid: 'tenant-A',
  };
  return {
    acceptedVersion: claims.accepted_version,
    authRecordExpiresAt: exp * 1000,
    authorizationId: claims.authorization_id,
    capabilities: claims.capabilities,
    gatewayTicket: `TEST.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.TEST`,
    principal,
    tenancyProtocol: 1,
    tenantId: claims.tid,
    ticketExpiresAt: exp * 1000,
    userId: claims.sub,
  };
};

export const respondToDeviceIdentityMint = (request: IncomingMessage, response: ServerResponse) => {
  if (request.url !== '/api/v1/gateway/identity') return false;
  let body = '';
  request.setEncoding('utf8').on('data', (chunk: string) => {
    body += chunk;
  });
  request.on('end', () => {
    const identity = deviceGatewayTestIdentity(JSON.parse(body));
    response.writeHead(200, {
      'Content-Type': 'application/json',
      'X-LobeHub-Gateway-Tenancy': '1',
      'X-LobeHub-Tenant-Id': identity.tenantId,
    });
    response.end(JSON.stringify(identity));
  });
  return true;
};

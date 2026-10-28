import { once } from 'node:events';

import { afterEach, describe, expect, it } from 'vitest';
import type WebSocket from 'ws';
import { WebSocketServer } from 'ws';

import { GatewayClient } from './client';

const clients: GatewayClient[] = [];
const servers: WebSocketServer[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.disconnect()));
  for (const server of servers.splice(0)) {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
const setup = async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  servers.push(server);
  await once(server, 'listening');
  const address = server.address() as { port: number };
  const now = Date.now();
  const identity = {
    tenancyProtocol: 1 as const,
    tenantId: 'tenant-A',
    userId: 'owner',
    principal: { kind: 'user' as const, id: 'owner' },
    capabilities: ['device:connect', 'device:respond'] as const,
    authorizationId: 'auth-A',
    acceptedVersion: 7,
    gatewayTicket: 'TEST-ONLY-SIGNED-BY-WORK-IN-PRODUCTION',
    ticketExpiresAt: now + 60_000,
    authRecordExpiresAt: now + 60_000,
  };
  const client = new GatewayClient({
    autoReconnect: false,
    gatewayUrl: `http://127.0.0.1:${address.port}`,
    token: identity.gatewayTicket,
    identityProvider: async () => ({ ...identity, capabilities: [...identity.capabilities] }),
  });
  clients.push(client);
  const connected = once(server, 'connection');
  await client.connect();
  const [socket, request] = (await connected) as [WebSocket, { url: string }];
  const auth = await once(socket, 'message');
  expect(JSON.parse(String(auth[0]))).toMatchObject({ tenancyProtocol: 1, tokenType: 'jwt' });
  expect(request.url).toMatch(/^\/tenant\/v1\/ws\?/);
  const confirmation = {
    type: 'auth_success',
    tenancyProtocol: 1,
    tenantId: identity.tenantId,
    principal: identity.principal,
    audience: 'urn:lobehub:gateway:device',
    roles: [...identity.capabilities],
    acceptedVersion: 7,
    connectionGeneration: 1,
    ticketExpiresAt: now + 60_000,
    authRecordExpiresAt: now + 60_000,
    leaseExpiresAt: now + 30_000,
  };
  return { client, socket, confirmation };
};
describe('real device WebSocket binding', () => {
  it('refuses a wrong tenant before connected or local execution', async () => {
    const { client, socket, confirmation } = await setup();
    let executed = false;
    client.on('tool_call_request', () => {
      executed = true;
    });
    const rejected = once(client, 'auth_failed');
    socket.send(JSON.stringify({ ...confirmation, tenantId: 'tenant-B' }));
    await rejected;
    expect(client.connectionStatus).not.toBe('connected');
    expect(executed).toBe(false);
  });
  it('requires the original command attempt on the returned response', async () => {
    const { client, socket, confirmation } = await setup();
    const connected = once(client, 'connected');
    socket.send(JSON.stringify(confirmation));
    await connected;
    const command = {
      type: 'tool_call_request',
      tenancyProtocol: 1,
      tenantId: 'tenant-A',
      sourceAcceptedVersion: 7,
      attemptId: 'attempt-A',
      connectionGeneration: 1,
      requestId: 'request-A',
      toolCall: { type: 'tool', identifier: 'test', apiName: 'run', arguments: '{}' },
    };
    const received = once(client, 'tool_call_request');
    socket.send(JSON.stringify(command));
    const [request] = await received;
    expect(request.isExecutionCurrent()).toBe(true);
    client.sendToolCallResponse({
      requestId: 'request-A',
      result: { content: 'forged', success: true },
    });
    const response = once(socket, 'message');
    client.sendToolCallResponse({ ...request, result: { content: 'ok', success: true } });
    expect(JSON.parse(String((await response)[0]))).toMatchObject({
      attemptId: 'attempt-A',
      connectionGeneration: 1,
      result: { content: 'ok' },
    });
    await client.disconnect();
    expect(request.executionSignal.aborted).toBe(true);
    expect(request.isExecutionCurrent()).toBe(false);
  });
});

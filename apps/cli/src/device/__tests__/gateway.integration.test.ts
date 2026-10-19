import { once } from 'node:events';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import type { GatewayIdentityResponse } from '@lobechat/agent-gateway-client';
import { GatewayClient } from '@lobechat/device-gateway-client';
import { extractBearerToken } from '@lobechat/utils/server/auth';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type WebSocket from 'ws';
import { WebSocketServer } from 'ws';

import { createGatewayIdentityProvider } from '../../auth/gatewayIdentity';
import type { GatewayHandlerContext } from '../gatewayHandlers';
import { bindGatewayClientHandlers } from '../gatewayHandlers';

// The real OpenAPI Bearer parser also shares a module with session helpers.
// Session lookup is outside this transport test; never mock the parser itself.
vi.mock('@/auth', () => ({ auth: {} }));

const fixture = JSON.parse(
  await readFile(
    new URL('../../../../../contracts/gateway-tenancy/v1/fixtures/ws-auth.json', import.meta.url),
    'utf8',
  ),
).cases.find((c: { id: string }) => c.id === 'auth-success-valid').input;

/** Real HTTP exchange, ws transport, CLI handlers and local-file runtime. Work/Go authority is a protocol fixture here. */
describe('CLI gateway transport through local execution', () => {
  let directory: string;
  let server: ReturnType<typeof createServer>;
  let gateway: WebSocketServer;
  let client: GatewayClient | undefined;
  let entry: string;
  let identity: GatewayIdentityResponse;
  const receivedIdentityBodies: Record<string, unknown>[] = [];

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'g6-cli-gateway-'));
    const exp = Math.floor(Date.now() / 1000) + 300;
    const claims = {
      iss: 'urn:lobehub:gateway-session',
      purpose: 'gateway-connect',
      aud: 'urn:lobehub:gateway:device',
      tid: 'tenant-A',
      sub: 'same-sub',
      principal: { kind: 'user' as const, id: 'same-sub' },
      capabilities: ['device:connect', 'device:respond'] as GatewayIdentityResponse['capabilities'],
      accepted_version: 7,
      authorization_id: 'original-authorization',
      exp,
    };
    identity = {
      tenancyProtocol: 1,
      tenantId: claims.tid,
      userId: claims.sub,
      principal: claims.principal,
      capabilities: claims.capabilities,
      authorizationId: claims.authorization_id,
      acceptedVersion: 7,
      ticketExpiresAt: exp * 1000,
      authRecordExpiresAt: exp * 1000,
      gatewayTicket: `TEST.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.TEST`,
    };
    receivedIdentityBodies.length = 0;
    server = createServer(async (req, res) => {
      if (
        req.url !== '/t/a/api/v1/gateway/identity' ||
        extractBearerToken(req.headers.authorization) !== 'TEST-ONLY'
      ) {
        res.writeHead(404).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const asked = JSON.parse(Buffer.concat(chunks).toString());
      receivedIdentityBodies.push(asked);
      // As Work does: sign the device and connection the client asked for.
      const signed = {
        ...claims,
        connection_id: asked.connectionId,
        device_id: asked.deviceId,
      };
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'X-LobeHub-Gateway-Tenancy': '1',
        'X-LobeHub-Tenant-Id': identity.tenantId,
      });
      res.end(
        JSON.stringify({
          ...identity,
          gatewayTicket: `TEST.${Buffer.from(JSON.stringify(signed)).toString('base64url')}.TEST`,
        }),
      );
    });
    gateway = new WebSocketServer({ server, path: '/tenant/v1/ws' });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    entry = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await client?.disconnect();
    for (const socket of gateway.clients) socket.terminate();
    await new Promise<void>((resolve) => gateway.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });

  const confirm = (socket: WebSocket) =>
    socket.send(
      JSON.stringify({
        ...fixture,
        tenantId: identity.tenantId,
        principal: identity.principal,
        audience: 'urn:lobehub:gateway:device',
        roles: identity.capabilities,
        acceptedVersion: 7,
        connectionGeneration: 1,
        ticketExpiresAt: identity.ticketExpiresAt,
        authRecordExpiresAt: identity.authRecordExpiresAt,
        leaseExpiresAt: Date.now() + 30_000,
      }),
    );
  const command = (tenantId = 'tenant-A') => ({
    type: 'tool_call_request',
    tenancyProtocol: 1,
    tenantId,
    sourceAcceptedVersion: 7,
    connectionGeneration: 1,
    attemptId: 'attempt-original',
    requestId: 'same-request',
    toolCall: {
      identifier: 'lobe-local-system',
      apiName: 'writeFile',
      type: 'tool',
      arguments: JSON.stringify({
        path: path.join(directory, 'effect.txt'),
        content: 'one correct execution',
      }),
    },
  });
  const open = async (
    run: GatewayHandlerContext['maintenance']['run'] = async (action) => action(),
  ) => {
    const auth = {
      serverUrl: `${entry}/t/a`,
      token: 'TEST-ONLY',
      tokenType: 'apiKey' as const,
      userId: 'same-sub',
    };
    client = new GatewayClient({
      gatewayUrl: entry,
      token: auth.token,
      identityProvider: createGatewayIdentityProvider(auth),
      userId: auth.userId,
      autoReconnect: false,
      tunnel: false,
    });
    bindGatewayClientHandlers(client, {
      deps: {},
      error: vi.fn(),
      info: vi.fn(),
      recordRequest: vi.fn(),
      isDaemonChild: false,
      getAuth: () => auth,
      maintenance: { run } as GatewayHandlerContext['maintenance'],
    });
    const accepted = once(gateway, 'connection');
    await client.connect();
    const [socket] = (await accepted) as [WebSocket];
    await once(socket, 'message'); // auth, never a legacy API key in the socket
    return socket;
  };

  it('waits for confirmation, executes the real local write, and returns the original attempt', async () => {
    const socket = await open();
    socket.send(JSON.stringify(command()));
    const connected = once(client!, 'connected');
    confirm(socket);
    await connected;
    // Deliver a new request after the ignored pre-auth request; no pending claim was created before confirmation.
    const response = once(socket, 'message');
    socket.send(JSON.stringify(command()));
    const [data] = await response;
    const result = JSON.parse(String(data));
    expect(result).toMatchObject({
      type: 'tool_call_response',
      attemptId: 'attempt-original',
      tenantId: 'tenant-A',
      result: { success: true },
    });
    expect(await readFile(path.join(directory, 'effect.txt'), 'utf8')).toBe(
      'one correct execution',
    );
    expect(receivedIdentityBodies[0]).toMatchObject({
      tenancyProtocol: 1,
      audience: 'urn:lobehub:gateway:device',
    });
  });

  it('does not execute a cross-tenant command after a valid handshake', async () => {
    const socket = await open();
    const connected = once(client!, 'connected');
    confirm(socket);
    await connected;
    const rejected = once(client!, 'auth_failed');
    socket.send(JSON.stringify(command('tenant-B')));
    await rejected;
    await expect(access(path.join(directory, 'effect.txt'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('does not execute a real queued write after disconnect invalidates its authority', async () => {
    let release!: () => void;
    let enqueued!: () => void;
    const queued = new Promise<void>((resolve) => {
      enqueued = resolve;
    });
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const socket = await open(async (action) => {
      enqueued();
      await wait;
      return action();
    });
    const connected = once(client!, 'connected');
    confirm(socket);
    await connected;
    socket.send(JSON.stringify(command()));
    await queued;
    await client!.disconnect();
    release();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await expect(access(path.join(directory, 'effect.txt'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});

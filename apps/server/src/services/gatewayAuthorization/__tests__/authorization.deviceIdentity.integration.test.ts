import { devices, session, users, workspaceMembers, workspaces } from '@lobechat/database/schemas';
import type { TenantScope } from '@lobechat/database/tenant';
import { runWithTenantScope } from '@lobechat/database/tenant';
import { eq } from 'drizzle-orm';
import { decodeJwt, exportJWK, generateKeyPair } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import type { LobeChatDatabase } from '@/database/type';
import { resetRedisClient } from '@/server/modules/Redis';
import { redisService } from '@/server/services/redis';

import { createGatewayAttempt } from '../attempts';
import { authorizeGateway } from '../authorize';
import { mintGatewayEnrollment, mintGatewayTicket } from '../index';
import type { GatewayAuthorizationSource, GatewayAuthorizeRequest } from '../types';
import { seedGatewaySourceRows } from './testUtils';

const state = vi.hoisted(() => ({
  jwks: '',
  version: 7,
  effectiveState: 'active',
  database: null as unknown,
}));
vi.mock('@/envs/auth', () => ({
  authEnv: {
    get JWKS_KEY() {
      return state.jwks;
    },
  },
}));
vi.mock('@/envs/redis', () => ({
  getRedisConfig: () => ({
    enabled: true,
    prefix: 'gw1017-test',
    tls: false,
    url: process.env.GATEWAY_TEST_REDIS_URL,
  }),
}));
vi.mock('@/database/core/db-adaptor', () => ({ getServerDB: async () => state.database }));
vi.mock('@lobechat/business-auth', () => ({
  assertBusinessUserAccess: async () => {},
  isBusinessAuthorizationError: () => false,
}));
vi.mock('@/server/modules/Tenant/runtime', () => ({
  getTenantRuntime: () => ({
    gatewayAdmission: async (tenantId: string) => ({
      tenantId,
      acceptedVersion: state.version,
      effectiveState: state.effectiveState,
      checkedAt: Date.now(),
      leaseExpiresAt: Date.now() + 30_000,
    }),
  }),
}));

let db: LobeChatDatabase;
const tenantId = 'tenant-A';
const subject = 'user-shared';
const operationId = 'operation-shared';
const sessionId = 'session-A';
const keyId = 'key-1';
const keyHash = 'TEST-ONLY-SHA256-FINGERPRINT';
const principal = { kind: 'user' as const, id: subject };
const scope = () =>
  ({
    tenantId,
    acceptedVersion: state.version,
    slug: 'test',
    endpoint: { basePath: '/orgs/test', publicUrl: 'http://test.invalid/orgs/test', version: 1 },
    session: { database: db },
  }) as TenantScope;
const run = <T>(fn: () => T) => runWithTenantScope(scope(), fn);
const source = (): GatewayAuthorizationSource => ({ kind: 'session', sessionId, subject });
const connectionRequest = (
  identity: { authorizationId: string; gatewayTicket: string },
  input?: Partial<GatewayAuthorizeRequest>,
): GatewayAuthorizeRequest => ({
  tenancyProtocol: 1,
  tenantId,
  authorizationId: identity.authorizationId,
  ticket: identity.gatewayTicket,
  audience: 'urn:lobehub:gateway:agent',
  expectedPrincipal: principal,
  operationId,
  action: 'connect',
  generation: 3,
  requestSeq: 4,
  ...input,
});

beforeAll(async () => {
  if (!process.env.GATEWAY_TEST_REDIS_URL?.startsWith('redis://127.0.0.1:'))
    throw new Error('A disposable loopback Redis is required');
  db = await getTestDB();
  state.database = db;
  const pair = await generateKeyPair('RS256', { extractable: true });
  state.jwks = JSON.stringify({
    keys: [{ ...(await exportJWK(pair.privateKey)), alg: 'RS256', kid: 'ephemeral-test' }],
  });
}, 120_000);
beforeEach(async () => {
  state.version = 7;
  state.effectiveState = 'active';
  await seedGatewaySourceRows(db, { tenantId, subject, operationId, sessionId, keyId, keyHash });
});
afterAll(async () => {
  await resetRedisClient();
});

describe('device identity is decided by Work, not by the client', () => {
  const team = { kind: 'workspace' as const, id: 'workspace-team' };
  const deviceAudience = 'urn:lobehub:gateway:device' as const;
  const actor = (id: 'user-b' | 'user-owner'): GatewayAuthorizationSource => ({
    kind: 'session',
    sessionId: `session-${id}`,
    subject: id,
  });
  const seedTeam = async () => {
    await db.delete(workspaces);
    await db.delete(devices);
    for (const id of ['user-b', 'user-owner']) {
      await db.insert(users).values({ id });
      await db.insert(session).values({
        id: `session-${id}`,
        userId: id,
        token: `TEST-ONLY-${id}`,
        expiresAt: new Date(Date.now() + 3600_000),
        updatedAt: new Date(),
      });
    }
    await db
      .insert(workspaces)
      .values({ id: team.id, slug: 'team', name: 'Team', primaryOwnerId: 'user-owner' });
    await db.insert(workspaceMembers).values([
      { workspaceId: team.id, userId: subject, role: 'admin' },
      { workspaceId: team.id, userId: 'user-b', role: 'admin' },
      { workspaceId: team.id, userId: 'user-owner', role: 'owner' },
    ]);
  };
  const enroll = (deviceId: string, userId: string, visibility: 'private' | 'public' = 'private') =>
    db.insert(devices).values({
      deviceId,
      identitySource: 'fallback',
      userId,
      visibility,
      workspaceId: team.id,
    });
  const device = (
    from: GatewayAuthorizationSource,
    deviceId: string | undefined,
    connectionId: string | undefined,
    onPrincipal: typeof team | typeof principal = team,
  ) =>
    mintGatewayTicket({
      audience: deviceAudience,
      source: from,
      principal: onPrincipal,
      capabilities: ['device:connect', 'device:respond'],
      deviceId,
      connectionId,
    });
  const renewRequest = (identity: Awaited<ReturnType<typeof device>>): GatewayAuthorizeRequest => ({
    ...connectionRequest(identity, { action: 'renew' }),
    audience: deviceAudience,
    expectedPrincipal: identity.principal,
    operationId: undefined,
  });
  beforeEach(seedTeam);

  it('signs the device and connection into the ticket and its authorization record', async () =>
    run(async () => {
      const identity = await device(source(), 'device-1', 'connection-1', principal);
      expect(decodeJwt(identity.gatewayTicket)).toMatchObject({
        aud: deviceAudience,
        device_id: 'device-1',
        connection_id: 'connection-1',
      });
      expect(
        await redisService.gatewayAuthorization.getAuthorization(identity.authorizationId),
      ).toMatchObject({ deviceId: 'device-1', connectionId: 'connection-1' });
    }));

  it.each([
    ['no device', undefined, 'connection-1'],
    ['no connection', 'device-1', undefined],
    ['a blank device', '   ', 'connection-1'],
    ['a control character', 'device\u0000-1', 'connection-1'],
    ['an overlong device', 'd'.repeat(65), 'connection-1'],
    ['an overlong connection', 'device-1', 'c'.repeat(129)],
    ['more bytes than characters', 'é'.repeat(33), 'connection-1'],
  ])('refuses a device ticket with %s', async (_name, deviceId, connectionId) =>
    run(async () => {
      await expect(device(source(), deviceId, connectionId, principal)).rejects.toMatchObject({
        code: 'INVALID_GATEWAY_MESSAGE',
        status: 400,
      });
    }),
  );

  it('keeps devices out of agent tickets and lets an agent client sign its connection', async () =>
    run(async () => {
      await expect(
        mintGatewayTicket({
          audience: 'urn:lobehub:gateway:agent',
          source: source(),
          principal,
          operationId,
          capabilities: ['agent:observe'],
          deviceId: 'device-1',
        }),
      ).rejects.toMatchObject({ code: 'INVALID_GATEWAY_MESSAGE' });
      const identity = await mintGatewayTicket({
        audience: 'urn:lobehub:gateway:agent',
        source: source(),
        principal,
        operationId,
        capabilities: ['agent:observe'],
        connectionId: 'tab-1',
      });
      expect(decodeJwt(identity.gatewayTicket)).toMatchObject({ connection_id: 'tab-1' });
      expect(decodeJwt(identity.gatewayTicket)).not.toHaveProperty('device_id');
    }));

  it("refuses to sign another member's private workspace device but not a shared or new one", async () =>
    run(async () => {
      await enroll('device-private', subject);
      await enroll('device-public', subject, 'public');
      const b = actor('user-b');
      await expect(device(b, 'device-private', 'connection-b')).rejects.toMatchObject({
        code: 'FORBIDDEN',
        status: 403,
      });
      await expect(device(b, 'device-public', 'connection-b')).resolves.toBeTruthy();
      await expect(device(b, 'device-new', 'connection-b')).resolves.toBeTruthy();
      await expect(device(source(), 'device-private', 'connection-a')).resolves.toBeTruthy();
      await expect(
        device(actor('user-owner'), 'device-private', 'connection-o'),
      ).resolves.toBeTruthy();
    }));

  it('refuses a renewal that names another device or connection', async () =>
    run(async () => {
      const original = await device(source(), 'device-1', 'connection-1');
      const renew = (deviceId: string, connectionId: string) =>
        mintGatewayTicket({
          audience: deviceAudience,
          source: source(),
          principal: team,
          capabilities: ['device:connect', 'device:respond'],
          deviceId,
          connectionId,
          renewAuthorizationId: original.authorizationId,
        });
      await expect(renew('device-2', 'connection-1')).rejects.toMatchObject({
        code: 'SOURCE_UNVERIFIABLE',
      });
      await expect(renew('device-1', 'connection-2')).rejects.toMatchObject({
        code: 'SOURCE_UNVERIFIABLE',
      });
      await expect(renew('device-1', 'connection-1')).resolves.toMatchObject({
        authorizationId: original.authorizationId,
      });
    }));

  it("revokes a claim on the next recheck once the device turns out to be another member's private one", async () =>
    run(async () => {
      const b = await device(actor('user-b'), 'device-a', 'connection-b');
      await expect(authorizeGateway(renewRequest(b))).resolves.toBeTruthy();
      await enroll('device-a', subject);
      await expect(authorizeGateway(renewRequest(b))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }));

  it('attests enrollment rights to admins without issuing a connectable ticket', async () =>
    run(async () => {
      const token = await mintGatewayEnrollment({ source: source(), principal: team });
      const claims = decodeJwt(token);
      expect(claims).toMatchObject({
        aud: deviceAudience,
        principal: team,
        purpose: 'gateway-enrollment',
        sub: subject,
      });
      expect(claims).not.toHaveProperty('device_id');
      expect(claims).not.toHaveProperty('authorization_id');
      await db
        .update(workspaceMembers)
        .set({ role: 'member' })
        .where(eq(workspaceMembers.userId, subject));
      await expect(
        mintGatewayEnrollment({ source: source(), principal: team }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }));

  describe('dispatch', () => {
    const dispatchTo = async (
      identity: Awaited<ReturnType<typeof device>>,
      resourceId: string,
      connectionId: string,
    ) => {
      const intent = await createGatewayAttempt({
        tenantId,
        sourceAcceptedVersion: 7,
        source: source(),
        targetPrincipal: team,
        action: 'device.rpc',
        resourceId,
        attemptExpiresAt: Date.now() + 30_000,
      });
      return authorizeGateway({
        ...connectionRequest(identity),
        audience: deviceAudience,
        expectedPrincipal: team,
        operationId: undefined,
        ticket: undefined,
        action: 'dispatch',
        sourceAcceptedVersion: 7,
        attemptId: intent.attemptId,
        generation: 3,
        dispatchBinding: {
          authorizationId: identity.authorizationId,
          connectionGeneration: 3,
          connectionId,
        },
      });
    };
    it('accepts the connection whose authorization was signed for the device', async () =>
      run(async () => {
        await enroll('device-a', subject, 'public');
        const a = await device(source(), 'device-a', 'connection-a');
        await expect(dispatchTo(a, 'device-a', 'connection-a')).resolves.toMatchObject({
          action: 'dispatch',
        });
      }));
    it('refuses a connection that was signed for a different device', async () =>
      run(async () => {
        await enroll('device-a', subject, 'public');
        const other = await device(actor('user-b'), 'device-b', 'connection-b');
        await expect(dispatchTo(other, 'device-a', 'connection-b')).rejects.toMatchObject({
          code: 'UNAUTHORIZED',
        });
      }));
    it('refuses a binding that names another connection of the same authorization', async () =>
      run(async () => {
        await enroll('device-a', subject, 'public');
        const a = await device(source(), 'device-a', 'connection-a');
        await expect(dispatchTo(a, 'device-a', 'connection-elsewhere')).rejects.toMatchObject({
          code: 'UNAUTHORIZED',
        });
      }));
    it('refuses a connection whose registrant may not host the device', async () =>
      run(async () => {
        const b = await device(actor('user-b'), 'device-a', 'connection-b');
        await enroll('device-a', subject);
        await expect(dispatchTo(b, 'device-a', 'connection-b')).rejects.toMatchObject({
          code: 'FORBIDDEN',
        });
      }));
  });
});

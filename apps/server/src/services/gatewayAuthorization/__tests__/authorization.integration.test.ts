import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import {
  agentOperations,
  apiKeys,
  oidcClients,
  oidcGrants,
  oidcSessions,
  session,
  users,
  workspaceMembers,
  workspaces,
} from '@lobechat/database/schemas';
import type { TenantScope } from '@lobechat/database/tenant';
import { runWithTenantScope } from '@lobechat/database/tenant';
import { eq } from 'drizzle-orm';
import { decodeJwt, exportJWK, generateKeyPair } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import type { LobeChatDatabase } from '@/database/type';
import { gatewayOperationPost } from '@/server/modules/AgentRuntime/gatewayHttp';
import { resetRedisClient } from '@/server/modules/Redis';
import { createGatewayInternalApp } from '@/server/router-hono/gatewayInternal';
import { gatewayRelayRouter } from '@/server/routers/lambda/aiAgent/gatewayRelay';
import { AbandonOperationService } from '@/server/services/agentRuntime/AbandonOperationService';
import { redisService } from '@/server/services/redis';

import { GatewayRoutes } from '../../../../../../packages/openapi/src/routes/gateway.route';
import { acceptGatewayCallback, createGatewayAttempt } from '../attempts';
import { authorizeGateway } from '../authorize';
import { runWithGatewaySource } from '../context';
import { mintGatewayTicket, mintOperationGatewayTicket } from '../index';
import { projectGatewayOIDCAccess } from '../oidcProjection';
import type {
  GatewayAuthorizationSource,
  GatewayAuthorizeRequest,
  GatewayCallback,
} from '../types';
import { waitForGatewayResult } from '../waiter';
import { parseGatewayWire } from '../wire';
import { seedGatewaySourceRows } from './testUtils';

const redisSuite = describe.skipIf(!process.env.GATEWAY_TEST_REDIS_URL);

const state = vi.hoisted(() => ({
  jwks: '',
  version: 7,
  effectiveState: 'active',
  database: null as unknown,
  requestSource: undefined as GatewayAuthorizationSource | undefined,
}));
// The owning HTTP handler and mint/renew implementation are real; only the
// preceding normal OpenAPI authentication boundary supplies this test source.
vi.mock('../../../../../../packages/openapi/src/middleware/auth', () => ({
  requireAuth: async (
    c: { set: (name: string, value: unknown) => void },
    next: () => Promise<void>,
  ) => {
    c.set('gatewaySource', state.requestSource);
    c.set('apiKeyScopes', null);
    await next();
  },
}));
// Runtime execution is outside this identity-only router test; avoid starting its transports.
vi.mock('@/server/services/agentRuntime', () => ({ AgentRuntimeService: vi.fn() }));
vi.mock('@/server/services/aiChat', () => ({ AiChatService: vi.fn() }));
vi.mock('@/server/services/heterogeneousAgent', () => ({ HeterogeneousAgentService: vi.fn() }));
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
let jti: string;
const principal = { kind: 'user' as const, id: subject };
const scope = (id = tenantId) =>
  ({
    tenantId: id,
    acceptedVersion: state.version,
    slug: 'test',
    endpoint: { basePath: '/orgs/test', publicUrl: 'http://test.invalid/orgs/test', version: 1 },
    session: { database: db },
  }) as TenantScope;
const run = <T>(fn: () => T, id = tenantId) => runWithTenantScope(scope(id), fn);
const source = (kind: string): GatewayAuthorizationSource => {
  if (kind === 'apiKey') return { kind, keyId, keyHash, subject };
  if (kind === 'oidc') return { kind, jti, subject };
  if (kind === 'operation') return { kind, operationId, subject };
  return { kind: 'session', sessionId, subject };
};
const mint = (kind = 'session') =>
  mintGatewayTicket({
    audience: 'urn:lobehub:gateway:agent',
    source: source(kind),
    principal,
    operationId,
    capabilities: ['agent:observe', 'agent:respond', 'agent:execute'],
  });
const connectionRequest = (
  identity: Awaited<ReturnType<typeof mint>>,
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

const sourceFixture = async (id: string) => {
  const fixtures = JSON.parse(
    await readFile(
      new URL(
        '../../../../../../contracts/gateway-tenancy/v2/fixtures/sources.json',
        import.meta.url,
      ),
      'utf8',
    ),
  ) as {
    cases: {
      id: string;
      input: GatewayAuthorizeRequest;
      expected: { accepted: boolean; code?: string };
    }[];
  };
  const fixture = fixtures.cases.find((entry) => entry.id === id);
  if (!fixture) throw new Error(`Missing source fixture: ${id}`);
  return fixture;
};
const materializeSourceRequest = (
  fixture: Awaited<ReturnType<typeof sourceFixture>>,
  identity: Awaited<ReturnType<typeof mint>>,
): GatewayAuthorizeRequest => ({
  ...fixture.input,
  authorizationId: identity.authorizationId,
  ticket: identity.gatewayTicket,
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
  jti = randomUUID();
  await seedGatewaySourceRows(db, { tenantId, subject, operationId, sessionId, keyId, keyHash });
  await run(() =>
    redisService.gatewayAuthorization.putOIDCProjection(jti, {
      tenantId,
      subject,
      clientId: 'tituwork-desktop',
      issuer: 'http://test.invalid/oidc',
      clientAuthority: 'database',
      grantId: 'grant-A',
      accessTokenExpiresAt: Date.now() + 300_000,
    }),
  );
});
afterAll(async () => {
  await resetRedisClient();
});

redisSuite('real source rows and immutable authorization ledger', () => {
  it.each(['session', 'apiKey', 'oidc', 'operation'])(
    'accepts an authorized %s source',
    async (kind) => {
      const fixture = await sourceFixture(`${kind}-valid`);
      await run(async () => {
        const identity = await mint(kind);
        const response = await authorizeGateway(materializeSourceRequest(fixture, identity));
        expect(response.leaseExpiresAt).toBeLessThanOrEqual(response.checkedAt + 30_000);
        expect(response.acceptedVersion).toBe(7);
      });
    },
  );
  it.each([
    ['session', 'session-deleted', () => db.delete(session)],
    [
      'apiKey',
      'api-key-revoked',
      () => db.update(apiKeys).set({ enabled: false }).where(eq(apiKeys.id, keyId)),
    ],
    ['oidc', 'oidc-grant-revoked', () => db.delete(oidcGrants)],
    ['oidc', 'oidc-client-disabled', () => db.update(oidcClients).set({ enabled: false })],
    ['oidc', 'oidc-client-disabled', () => db.delete(oidcClients)],
    [
      'operation',
      'operation-cancelled',
      () => db.update(agentOperations).set({ status: 'interrupted' }),
    ],
  ] as const)('revokes an already minted %s lease: %s', async (kind, fixtureId, revoke) => {
    const fixture = await sourceFixture(fixtureId);
    await run(async () => {
      const identity = await mint(kind);
      await revoke();
      await expect(
        authorizeGateway(materializeSourceRequest(fixture, identity)),
      ).rejects.toMatchObject({
        code: fixture.expected.code,
      });
    });
  });
  it('revokes an already minted ticket when the account is banned', async () =>
    run(async () => {
      const identity = await mint();
      await db.update(users).set({ banned: true }).where(eq(users.id, subject));
      await expect(authorizeGateway(connectionRequest(identity))).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
    }));
  it('does not let another login source renew an original authorization', async () =>
    run(async () => {
      const identity = await mint();
      await expect(
        runWithGatewaySource(source('apiKey'), () =>
          mintOperationGatewayTicket(subject, operationId, undefined, identity.authorizationId),
        ),
      ).rejects.toMatchObject({ code: 'SOURCE_UNVERIFIABLE' });
      await expect(
        runWithGatewaySource(source('session'), () =>
          mintOperationGatewayTicket(subject, operationId, undefined, identity.authorizationId),
        ),
      ).resolves.toEqual(expect.any(String));
    }));
  it('does not replace an unverifiable request source with background operation authority', async () =>
    run(async () => {
      await expect(
        runWithGatewaySource(undefined, async () => {
          await mintOperationGatewayTicket(subject, operationId);
          return true;
        }),
      ).rejects.toMatchObject({ code: 'SOURCE_UNVERIFIABLE' });
      await expect(mintOperationGatewayTicket(subject, operationId).then(() => true)).resolves.toBe(
        true,
      );
    }));
  it('rechecks a workspace enroller role after minting', async () =>
    run(async () => {
      await db.insert(workspaces).values({
        id: 'workspace-test',
        slug: 'gateway-test',
        name: 'Gateway',
        primaryOwnerId: subject,
      });
      await db
        .insert(workspaceMembers)
        .values({ workspaceId: 'workspace-test', userId: subject, role: 'admin' });
      const identity = await mintGatewayTicket({
        audience: 'urn:lobehub:gateway:device',
        source: source('session'),
        principal: { kind: 'workspace', id: 'workspace-test' },
        capabilities: ['device:connect', 'device:respond'],
        deviceId: 'device-shared',
        connectionId: 'connection-shared',
      });
      const request = {
        ...connectionRequest(identity),
        audience: 'urn:lobehub:gateway:device' as const,
        operationId: undefined,
        expectedPrincipal: identity.principal,
      };
      await expect(authorizeGateway(request)).resolves.toMatchObject({
        principal: identity.principal,
      });
      await db
        .update(workspaceMembers)
        .set({ role: 'member' })
        .where(eq(workspaceMembers.workspaceId, 'workspace-test'));
      await expect(authorizeGateway(request)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }));
  it('uses the durable operation version in the actual notifier HTTP envelope', async () =>
    run(async () => {
      const response = new Response('{}', {
        headers: { 'X-LobeHub-Gateway-Tenancy': '1', 'X-LobeHub-Tenant-Id': tenantId },
      });
      const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response);
      try {
        await gatewayOperationPost(
          'http://gateway.invalid/tenant/v1',
          'TEST-ONLY',
          '/api/operations/push-event',
          { operationId, event: { type: 'step_start' } },
          new AbortController().signal,
        );
        expect(fetch.mock.calls[0][0]).toBe(
          'http://gateway.invalid/tenant/v1/api/operations/push-event',
        );
        const request = fetch.mock.calls[0][1]!;
        expect(request.redirect).toBe('error');
        expect(request.headers).toMatchObject({
          'X-LobeHub-Tenant-Id': tenantId,
          'X-LobeHub-Tenant-Version': '7',
        });
        expect(JSON.parse(request.body as string)).toMatchObject({
          sourceAcceptedVersion: 7,
          userId: subject,
        });
      } finally {
        fetch.mockRestore();
      }
    }));
  it('projects issuance before signing and revokes a bound OIDC session', async () =>
    run(async () => {
      jti = randomUUID();
      await db.insert(oidcSessions).values({
        id: 'session-oidc',
        userId: subject,
        data: { uid: 'bound-uid' },
        expiresAt: new Date(Date.now() + 60_000),
      });
      await projectGatewayOIDCAccess(
        {} as any,
        {
          clientId: 'tituwork-desktop',
          expiresWithSession: true,
          grantId: 'grant-A',
          sessionUid: 'bound-uid',
        } as any,
        {
          payload: {
            jti,
            sub: subject,
            iss: 'http://test.invalid/oidc',
            exp: Math.floor(Date.now() / 1000) + 300,
          },
        } as any,
      );
      const identity = await mint('oidc');
      expect(identity.ticketExpiresAt).toBeLessThanOrEqual(Date.now() + 60_000);
      await db.delete(oidcSessions).where(eq(oidcSessions.id, 'session-oidc'));
      await expect(authorizeGateway(connectionRequest(identity))).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
    }));
  // An offline_access token (the desktop app's refresh-token grant) carries the
  // login's sessionUid but does not expire with it: signing out of the browser
  // that completed the device login must not cut the app off from the gateway.
  it('keeps an offline OIDC token usable after the login session ends', async () =>
    run(async () => {
      jti = randomUUID();
      await db.insert(oidcSessions).values({
        id: 'session-oidc-offline',
        userId: subject,
        data: { uid: 'offline-uid' },
        expiresAt: new Date(Date.now() + 60_000),
      });
      await projectGatewayOIDCAccess(
        {} as any,
        {
          clientId: 'tituwork-desktop',
          expiresWithSession: false,
          grantId: 'grant-A',
          sessionUid: 'offline-uid',
        } as any,
        {
          payload: {
            jti,
            sub: subject,
            iss: 'http://test.invalid/oidc',
            exp: Math.floor(Date.now() / 1000) + 300,
          },
        } as any,
      );
      await db.delete(oidcSessions).where(eq(oidcSessions.id, 'session-oidc-offline'));
      const identity = await mint('oidc');
      await expect(authorizeGateway(connectionRequest(identity))).resolves.toMatchObject({
        tenantId,
      });
    }));
  it('settles cross-version cleanup in the real abandon service without running hooks or resuming', async () =>
    run(async () => {
      const deleteAgentOperation = vi.fn().mockResolvedValue(undefined);
      const coordinator = {
        deleteAgentOperation,
        loadAgentState: () => {
          throw new Error('cleanup must not execute runtime work');
        },
      };
      const service = new AbandonOperationService(db, {
        coordinator: coordinator as any,
        snapshotStore: null,
      });
      const result = await service.finalizeAbandoned(operationId, 'watchdog', {
        cleanupOnly: true,
      });
      expect(result.abandoned).toBe(true);
      expect(
        (await db.select().from(agentOperations).where(eq(agentOperations.id, operationId)))[0]
          .status,
      ).toBe('error');
      expect(deleteAgentOperation).toHaveBeenCalledOnce();
    }));
  it('does not let a valid second key renew a revoked first source', async () =>
    run(async () => {
      const identity = await mint('apiKey');
      await db.insert(apiKeys).values({
        id: 'key-2',
        userId: subject,
        key: 'OTHER-TEST-CIPHERTEXT',
        keyHash: 'OTHER-HASH',
        name: 'Other',
        enabled: true,
      });
      await db.update(apiKeys).set({ enabled: false }).where(eq(apiKeys.id, keyId));
      await expect(
        authorizeGateway(connectionRequest(identity, { action: 'renew' })),
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    }));
  it('never reconstructs a missing OIDC projection from a JWT subject', async () =>
    run(async () => {
      jti = 'missing-projection';
      await expect(mint('oidc')).rejects.toMatchObject({ code: 'SOURCE_UNVERIFIABLE' });
    }));
  it('refuses a narrow key for whole-principal device registration', async () =>
    run(async () => {
      await db.update(apiKeys).set({ scopes: ['user:read'] });
      await expect(
        mintGatewayTicket({
          audience: 'urn:lobehub:gateway:device',
          source: source('apiKey'),
          principal,
          capabilities: ['device:connect'],
          deviceId: 'device-shared',
          connectionId: 'connection-shared',
        }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }));
  it('isolates equal authorization IDs through the actual tenant Redis prefix', async () => {
    const identity = await run(() => mint());
    await run(async () => {
      await expect(
        authorizeGateway({ ...connectionRequest(identity), tenantId: 'tenant-B' }),
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    }, 'tenant-B');
  });
});

redisSuite('A2 owning identity renewal with real source records and Redis', () => {
  const device = (kind: string) =>
    mintGatewayTicket({
      audience: 'urn:lobehub:gateway:device',
      source: source(kind),
      principal,
      capabilities: ['device:connect', 'device:respond'],
      deviceId: 'device-shared',
      connectionId: 'connection-shared',
    });
  const fixture = async (id: string) => {
    const data = JSON.parse(
      await readFile(
        new URL(
          '../../../../../../contracts/gateway-tenancy/v2/fixtures/authorize.json',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    const entry = data.cases.find((item: { id: string }) => item.id === id);
    if (!entry) throw new Error(`Missing A2 fixture: ${id}`);
    return entry;
  };
  const request = (input: Record<string, unknown>) =>
    GatewayRoutes.request('/identity', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
  it.each(['session', 'apiKey', 'oidc'])(
    'renews the same %s authorization at the actual HTTP handler',
    async (kind) =>
      run(async () => {
        const entry = await fixture(`a2-same-${kind}-renew`);
        const original = await device(kind);
        state.requestSource = source(kind);
        const response = await request({
          ...entry.input,
          renewAuthorizationId: original.authorizationId,
        });
        expect(response.status).toBe(200);
        const renewed = await response.json();
        expect(renewed.authorizationId).toBe(original.authorizationId);
        expect(renewed.gatewayTicket !== original.gatewayTicket).toBe(true);
        const record = await redisService.gatewayAuthorization.getAuthorization(
          original.authorizationId,
        );
        expect(record?.authorizationId).toBe(original.authorizationId);
      }),
  );
  it.each([
    'different-session',
    'different-key',
    'different-principal',
    'different-workspace',
    'different-audience',
    'different-operation',
    'revoked-source',
    'unknown-id',
  ])('refuses a2-%s without silently minting', async (kind) =>
    run(async () => {
      const entry = await fixture(`a2-${kind}`);
      const original = await device(kind === 'different-key' ? 'apiKey' : 'session');
      state.requestSource = source(kind === 'different-key' ? 'apiKey' : 'session');
      const input = { ...entry.input, renewAuthorizationId: original.authorizationId };
      if (kind === 'different-session') {
        await db.insert(session).values({
          id: 'session-B',
          userId: subject,
          token: 'TEST-ONLY-B',
          expiresAt: new Date(Date.now() + 3600_000),
          updatedAt: new Date(),
        });
        state.requestSource = { kind: 'session', subject, sessionId: 'session-B' };
      }
      if (kind === 'different-key') {
        await db.insert(apiKeys).values({
          id: 'key-B',
          userId: subject,
          key: 'TEST-ONLY',
          keyHash: 'TEST-ONLY-B',
          name: 'Other',
          enabled: true,
          scopes: null,
        });
        state.requestSource = { kind: 'apiKey', subject, keyId: 'key-B', keyHash: 'TEST-ONLY-B' };
      }
      if (kind === 'different-principal')
        state.requestSource = { kind: 'session', subject: 'other', sessionId };
      if (kind === 'different-workspace') input.workspaceId = 'other-workspace';
      if (kind === 'different-audience') {
        input.audience = 'urn:lobehub:gateway:agent';
        input.operationId = operationId;
        delete input.deviceId;
        delete input.connectionId;
      }
      if (kind === 'different-operation') input.operationId = operationId;
      if (kind === 'revoked-source') await db.delete(session);
      if (kind === 'unknown-id') input.renewAuthorizationId = randomUUID();
      const response = await request(input);
      expect(response.status).toBe(401);
      expect((await response.json()).error.code).toBe('SOURCE_UNVERIFIABLE');
    }),
  );
  it('rejects a cross-tenant authorization with the same safe response as an unknown ID', async () => {
    const entry = await fixture('a2-cross-tenant');
    const original = await run(() => device('session'));
    state.requestSource = source('session');
    const response = await run(
      () => request({ ...entry.input, renewAuthorizationId: original.authorizationId }),
      'tenant-B',
    );
    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe('SOURCE_UNVERIFIABLE');
  });
  it('returns the same error for revoked and unknown records', async () =>
    run(async () => {
      const entry = await fixture('a2-revoked-record');
      const original = await device('session');
      state.requestSource = source('session');
      await redisService.gatewayAuthorization.revokeAuthorization(original.authorizationId);
      const revoked = await request({
        ...entry.input,
        renewAuthorizationId: original.authorizationId,
      });
      const missing = await request({ ...entry.input, renewAuthorizationId: randomUUID() });
      expect(revoked.status).toBe(401);
      expect(await revoked.json()).toEqual(await missing.json());
    }));
  it('keeps the original authorization ID on the agent mint path too', async () =>
    run(async () => {
      const original = await mint();
      const token = await runWithGatewaySource(source('session'), () =>
        mintOperationGatewayTicket(subject, operationId, undefined, original.authorizationId),
      );
      expect(decodeJwt(token).authorization_id).toBe(original.authorizationId);
      expect(token !== original.gatewayTicket).toBe(true);
    }));
  it('atomically rejects an outdated renewal after the same record was replaced', async () =>
    run(async () => {
      const original = await device('session');
      const previous = (await redisService.gatewayAuthorization.getAuthorization(
        original.authorizationId,
      ))!;
      const results = await Promise.allSettled(
        ['one', 'two'].map((jti) =>
          redisService.gatewayAuthorization.renewAuthorization(previous, { ...previous, jti }),
        ),
      );
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    }));
  it('extends the same authorization through the initial deadline without exceeding source expiry', async () =>
    run(async () => {
      const initial = Date.now();
      const sourceDeadline = initial + 600_000;
      await db.update(session).set({ expiresAt: new Date(sourceDeadline) });
      const original = await device('session');
      state.requestSource = source('session');
      const rolling = await fixture('a2-rolling-past-initial-record');
      const clock = vi.spyOn(Date, 'now');
      try {
        let previousDeadline = original.authRecordExpiresAt;
        for (const elapsed of [150_000, 300_000, 450_000]) {
          clock.mockReturnValue(initial + elapsed);
          const response = await request({
            ...rolling.input,
            renewAuthorizationId: original.authorizationId,
          });
          expect(response.status).toBe(200);
          const body = await response.json();
          expect(body.authorizationId).toBe(original.authorizationId);
          expect(body.authRecordExpiresAt).toBeGreaterThanOrEqual(previousDeadline);
          expect(body.authRecordExpiresAt).toBeLessThanOrEqual(sourceDeadline);
          expect(body.ticketExpiresAt).toBeLessThanOrEqual(Date.now() + 300_000);
          previousDeadline = body.authRecordExpiresAt;
        }
        const expired = await fixture('a2-source-expired-refuses-extension');
        clock.mockReturnValue(sourceDeadline + 1);
        const denied = await request({
          ...expired.input,
          renewAuthorizationId: original.authorizationId,
        });
        expect(denied.status).toBe(401);
        expect((await denied.json()).error.code).toBe('SOURCE_UNVERIFIABLE');
      } finally {
        clock.mockRestore();
      }
    }));
  it('keeps an existing socket periodic check valid during the identity-to-auth-frame handoff', async () =>
    run(async () => {
      const original = await device('session');
      state.requestSource = source('session');
      const handoff = await fixture('a2-existing-socket-ticket-handoff');
      const periodic: GatewayAuthorizeRequest = {
        ...handoff.input,
        authorizationId: original.authorizationId,
        ticket: original.gatewayTicket,
      };
      await authorizeGateway(periodic);
      const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 1500);
      try {
        const renewed = await request({
          tenancyProtocol: 1,
          audience: periodic.audience,
          deviceId: 'device-shared',
          connectionId: 'connection-shared',
          renewAuthorizationId: original.authorizationId,
        });
        expect(renewed.status).toBe(200);
        const current = await renewed.json();
        await expect(
          authorizeGateway({
            ...periodic,
            action: 'connect',
            ticket: current.gatewayTicket,
          }),
        ).resolves.toMatchObject({ authorizationId: original.authorizationId });
        const lease = await authorizeGateway(periodic);
        expect(lease.ticketExpiresAt).toBe(original.ticketExpiresAt);
        await expect(authorizeGateway({ ...periodic, action: 'connect' })).rejects.toMatchObject({
          code: 'UNAUTHORIZED',
        });
        expect(lease.leaseExpiresAt).toBeLessThanOrEqual(original.ticketExpiresAt);
        await db.delete(session);
        await expect(authorizeGateway(periodic)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
      } finally {
        clock.mockRestore();
      }
    }));
  it('does not renew an expired record even while Redis still holds its bytes', async () =>
    run(async () => {
      const entry = await fixture('a2-expired-record');
      const original = await device('session');
      state.requestSource = source('session');
      const clock = vi.spyOn(Date, 'now').mockReturnValue(original.authRecordExpiresAt + 1);
      try {
        const response = await request({
          ...entry.input,
          renewAuthorizationId: original.authorizationId,
        });
        expect(response.status).toBe(401);
        expect((await response.json()).error.code).toBe('SOURCE_UNVERIFIABLE');
      } finally {
        clock.mockRestore();
      }
    }));
});

redisSuite('atomic Work claim and original attempt result binding', () => {
  const prepare = async () => {
    const identity = await mint();
    const intent = await createGatewayAttempt({
      tenantId,
      sourceAcceptedVersion: 7,
      source: source('session'),
      targetPrincipal: principal,
      action: 'operations.tool-execute',
      operationId,
      toolCallId: 'same-tool-id',
      resourceId: operationId,
      attemptExpiresAt: Date.now() + 30_000,
    });
    const binding = {
      authorizationId: identity.authorizationId,
      connectionId: 'actual-executor-socket',
      connectionGeneration: 3,
    };
    const request = connectionRequest(identity, {
      action: 'dispatch',
      ticket: undefined,
      sourceAcceptedVersion: 7,
      attemptId: intent.attemptId,
      dispatchBinding: binding,
    });
    return { intent, binding, request };
  };
  it('grants exactly one send permission to two concurrent claim requests', async () =>
    run(async () => {
      const { request } = await prepare();
      const claims = await Promise.allSettled([
        authorizeGateway(request),
        authorizeGateway(request),
      ]);
      expect(claims.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(claims.filter((result) => result.status === 'rejected')).toHaveLength(1);
    }));
  it('late or duplicate callbacks cannot settle a replacement waiter', async () =>
    run(async () => {
      const old = await prepare();
      await authorizeGateway(old.request);
      const fresh = await prepare();
      const callback: GatewayCallback = {
        tenancyProtocol: 1,
        tenantId,
        sourceAcceptedVersion: 7,
        operationId,
        toolCallId: 'same-tool-id',
        attemptId: old.intent.attemptId,
        dispatchBinding: old.binding,
        outcome: 'completed',
        result: { content: 'old', success: true },
      };
      await acceptGatewayCallback(callback);
      expect(
        (await redisService.gatewayAuthorization.getAttempt(fresh.intent.attemptId))?.result,
      ).toBeUndefined();
      await expect(acceptGatewayCallback(callback)).rejects.toMatchObject({
        code: 'ATTEMPT_CONFLICT',
      });
    }));
  it('drains an independent-worker waiter after an authoritative freeze without a callback', async () =>
    run(async () => {
      const { intent, request } = await prepare();
      await authorizeGateway(request);
      state.effectiveState = 'frozen';
      await expect(
        waitForGatewayResult(
          { operationId, toolCallId: intent.toolCallId!, attemptId: intent.attemptId },
          {
            execution: { tenantId, sourceAcceptedVersion: 7 },
            expiresAt: intent.attemptExpiresAt,
            signal: new AbortController().signal,
          },
        ),
      ).rejects.toMatchObject({ code: 'TENANT_FROZEN' });
      expect((await redisService.gatewayAuthorization.getAttempt(intent.attemptId))?.state).toBe(
        'executionUnknown',
      );
    }));
  it('refuses the original queued attempt after active renewal advances the lifecycle version', async () =>
    run(async () => {
      const { request } = await prepare();
      state.version = 9;
      await expect(authorizeGateway(request)).rejects.toMatchObject({
        code: 'TENANT_EXECUTION_VERSION_STALE',
      });
    }));
});

const mintUser = (kind = 'session', extra: Partial<Parameters<typeof mintGatewayTicket>[0]> = {}) =>
  mintGatewayTicket({
    audience: 'urn:lobehub:gateway:agent',
    source: source(kind),
    principal,
    connectionId: 'tab',
    capabilities: ['agent:observe', 'agent:respond', 'agent:execute'],
    ...extra,
  });
const userRequest = (
  identity: Awaited<ReturnType<typeof mint>>,
  input: Partial<GatewayAuthorizeRequest> = {},
) => connectionRequest(identity, { operationId: undefined, ...input });

redisSuite('v2 user-ticket authorization', () => {
  it('issues and renews the tRPC user ticket through the actual mint and ledger', async () =>
    run(async () => {
      const caller = gatewayRelayRouter.createCaller({
        userId: subject,
        gatewaySource: source('session'),
        jwtPayload: { userId: subject },
      });
      await runWithGatewaySource(source('session'), async () => {
        const { token } = await caller.issueGatewayUserToken({ clientId: 'router-tab' });
        const claims = decodeJwt(token);
        parseGatewayWire('tokenClaims', claims);
        expect(claims).toMatchObject({ sub: subject, principal, connection_id: 'router-tab' });
        expect(claims.operation_id).toBeUndefined();
        const renewed = await caller.issueGatewayUserToken({
          clientId: 'router-tab',
          authorizationId: String(claims.authorization_id),
        });
        expect(decodeJwt(renewed.token).authorization_id).toBe(claims.authorization_id);
        expect(
          (
            await redisService.gatewayAuthorization.getAuthorization(
              String(claims.authorization_id),
            )
          )?.operationId,
        ).toBeUndefined();
      });
      for (const input of [{}, { clientId: '' }, { clientId: 'x'.repeat(129) }])
        await expect(
          caller.issueGatewayUserToken(input as { clientId: string }),
        ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      const unauthenticated = gatewayRelayRouter.createCaller({
        userId: subject,
        jwtPayload: { userId: subject },
      });
      await expect(unauthenticated.issueGatewayUserToken({ clientId: 'tab' })).rejects.toThrow(
        'SOURCE_UNVERIFIABLE',
      );
    }));

  it.each(['session', 'apiKey', 'oidc'])(
    'mints and renews a %s user ticket without an operation',
    async (kind) =>
      run(async () => {
        const identity = await mintUser(kind);
        const claims = decodeJwt(identity.gatewayTicket);
        expect(parseGatewayWire('tokenClaims', claims)).toBe(claims);
        expect(claims).toMatchObject({
          sub: subject,
          principal,
          connection_id: 'tab',
          capabilities: ['agent:observe', 'agent:respond', 'agent:execute'],
        });
        expect(claims.operation_id).toBeUndefined();
        expect(claims.exp! - claims.iat!).toBeLessThanOrEqual(300);
        expect(
          (await redisService.gatewayAuthorization.getAuthorization(identity.authorizationId))
            ?.operationId,
        ).toBeUndefined();
        await expect(authorizeGateway(userRequest(identity))).resolves.toMatchObject({
          authorizationId: identity.authorizationId,
        });
        const renewed = await mintUser(kind, { renewAuthorizationId: identity.authorizationId });
        expect(renewed.authorizationId).toBe(identity.authorizationId);
        await expect(
          authorizeGateway(userRequest(renewed, { action: 'renew' })),
        ).resolves.toMatchObject({ authorizationId: identity.authorizationId });
        for (const action of ['connect', 'renew'] as const)
          await expect(
            authorizeGateway(userRequest(renewed, { action, operationId })),
          ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
        await expect(
          mintUser(kind, {
            connectionId: 'other-tab',
            renewAuthorizationId: identity.authorizationId,
          }),
        ).rejects.toMatchObject({ code: 'SOURCE_UNVERIFIABLE' });
      }),
  );
  it.each([undefined, '', 'x'.repeat(129)])(
    'rejects invalid user connection id',
    async (connectionId) =>
      run(async () => {
        await expect(mintUser('session', { connectionId })).rejects.toMatchObject({
          code: 'INVALID_GATEWAY_MESSAGE',
        });
      }),
  );
  it('refuses background authority for a user ticket', async () =>
    run(async () => {
      await expect(mintUser('operation')).rejects.toMatchObject({ code: 'SOURCE_UNVERIFIABLE' });
    }));
  it('keeps workspace-key user tickets scoped to their workspace and membership', async () =>
    run(async () => {
      const workspaceId = 'mux-workspace';
      await db.insert(workspaces).values({
        id: workspaceId,
        slug: workspaceId,
        name: 'Mux',
        primaryOwnerId: subject,
      });
      await db.insert(workspaceMembers).values({ workspaceId, userId: subject });
      await db.update(apiKeys).set({ workspaceId });
      const identity = await mintUser('apiKey', {
        source: { kind: 'apiKey', subject, keyId, keyHash, workspaceId },
      });
      const request = userRequest(identity, {
        action: 'subscribe',
        operationId,
        roles: ['agent:observe'],
      });
      await expect(authorizeGateway(request)).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
      await db.update(agentOperations).set({ workspaceId });
      await expect(authorizeGateway(request)).resolves.toMatchObject({ operationId });
      await db.delete(workspaceMembers);
      await expect(authorizeGateway(userRequest(identity))).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
    }));
  it('permits a read-scoped key only to observe', async () =>
    run(async () => {
      await db.update(apiKeys).set({ scopes: ['chat:read'] });
      await expect(mintUser('apiKey')).rejects.toMatchObject({ code: 'FORBIDDEN' });
      const identity = await mintUser('apiKey', { capabilities: ['agent:observe'] });
      await expect(authorizeGateway(userRequest(identity))).resolves.toMatchObject({
        authorizationId: identity.authorizationId,
      });
      await expect(
        authorizeGateway(
          userRequest(identity, { action: 'subscribe', operationId, roles: ['agent:execute'] }),
        ),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }));
  it.each(['connect', 'renew', 'subscribe'] as const)(
    'rechecks sources for user %s',
    async (action) =>
      run(async () => {
        const checks = [
          async () => {
            await db.delete(session);
          },
          async () => {
            await db.update(users).set({ banned: true });
          },
          async () => {
            await db.update(apiKeys).set({ expiresAt: new Date(0) });
          },
          async () => {
            state.version = 8;
          },
        ];
        for (let index = 0; index < checks.length; index++) {
          await seedGatewaySourceRows(db, {
            tenantId,
            subject,
            operationId,
            sessionId,
            keyId,
            keyHash,
          });
          state.version = 7;
          const identity = await mintUser(index === 2 ? 'apiKey' : 'session');
          await checks[index]();
          await expect(
            authorizeGateway(
              userRequest(identity, {
                action,
                ...(action === 'subscribe' ? { operationId, roles: ['agent:observe'] } : {}),
              }),
            ),
          ).rejects.toMatchObject({
            code: index === 3 ? 'TENANT_EXECUTION_VERSION_STALE' : 'UNAUTHORIZED',
          });
        }
      }),
  );
  it('subscribes to retained owner and stream-owner operations with their stored version', async () =>
    run(async () => {
      const identity = await mintUser();
      const request = userRequest(identity, {
        action: 'subscribe',
        operationId,
        roles: ['agent:observe', 'agent:respond'],
      });
      await db.update(agentOperations).set({ status: 'done' });
      await expect(authorizeGateway(request)).resolves.toMatchObject({
        operationId,
        roles: request.roles,
        sourceAcceptedVersion: 7,
      });
      await db.insert(users).values({ id: 'other' });
      await db.update(agentOperations).set({
        userId: 'other',
        metadata: { tenantId, sourceAcceptedVersion: 7, streamOwnerUserId: subject },
      });
      await expect(authorizeGateway(request)).resolves.toMatchObject({ sourceAcceptedVersion: 7 });
    }));
  it('uses byte-identical HTTP denials for absent, foreign, non-owned and stale operations', async () =>
    run(async () => {
      const identity = await mintUser();
      await db.insert(users).values({ id: 'other' });
      await db.insert(agentOperations).values([
        {
          id: 'foreign',
          userId: subject,
          status: 'running',
          metadata: { tenantId: 'tenant-B', sourceAcceptedVersion: 7 },
        },
        {
          id: 'other-op',
          userId: 'other',
          status: 'running',
          metadata: { tenantId, sourceAcceptedVersion: 7 },
        },
        {
          id: 'stale',
          userId: subject,
          status: 'running',
          metadata: { tenantId, sourceAcceptedVersion: 6 },
        },
      ]);
      const app = createGatewayInternalApp({
        serviceTokens: () => ['test-service'],
        run: async (_id, fn) => fn(),
      });
      const bodies = [];
      for (const id of ['missing', 'foreign', 'other-op', 'stale']) {
        const response = await app.request('/api/internal/gateway/authorize', {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer test-service',
            'Content-Type': 'application/json',
            'X-LobeHub-Gateway-Tenancy': '1',
            'X-LobeHub-Tenant-Id': tenantId,
          },
          body: JSON.stringify(
            userRequest(identity, {
              ticket: undefined,
              action: 'subscribe',
              operationId: id,
              roles: ['agent:observe'],
            }),
          ),
        });
        expect(response.status).toBe(404);
        bodies.push(await response.text());
      }
      expect(new Set(bodies).size).toBe(1);
      expect(JSON.parse(bodies[0])).toEqual({
        tenancyProtocol: 1,
        error: { code: 'RESOURCE_NOT_FOUND', message: 'RESOURCE_NOT_FOUND' },
      });
    }));
  it('rejects subscribe on operation tickets', async () =>
    run(async () => {
      await expect(
        authorizeGateway(
          connectionRequest(await mint(), { action: 'subscribe', roles: ['agent:observe'] }),
        ),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }));
  it('exchanges a user identity at the HTTP handler and rejects missing connectionId', async () =>
    run(async () => {
      state.requestSource = source('session');
      for (const connectionId of ['tab', undefined]) {
        const response = await GatewayRoutes.request('/identity', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tenancyProtocol: 1,
            audience: 'urn:lobehub:gateway:agent',
            connectionId,
          }),
        });
        expect(response.status).toBe(connectionId ? 200 : 400);
        if (connectionId) parseGatewayWire('identityResponse', await response.json());
      }
    }));
  it.each(['operations.tool-execute', 'operations.request-input'] as const)(
    'requires the command role for user-ticket %s dispatch',
    async (action) =>
      run(async () => {
        const identity = await mintUser('session', { capabilities: ['agent:observe'] });
        const intent = await createGatewayAttempt({
          tenantId,
          sourceAcceptedVersion: 7,
          source: source('session'),
          targetPrincipal: principal,
          action,
          operationId,
          toolCallId: 'role-check',
          resourceId: operationId,
          attemptExpiresAt: Date.now() + 30_000,
        });
        await expect(
          authorizeGateway(
            userRequest(identity, {
              action: 'dispatch',
              operationId,
              sourceAcceptedVersion: 7,
              attemptId: intent.attemptId,
              dispatchBinding: {
                authorizationId: identity.authorizationId,
                connectionId: 'tab',
                connectionGeneration: 3,
              },
            }),
          ),
        ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      }),
  );
  it('claims and settles only an owned operation with the signed socket binding', async () =>
    run(async () => {
      const identity = await mintUser();
      const intent = await createGatewayAttempt({
        tenantId,
        sourceAcceptedVersion: 7,
        source: source('session'),
        targetPrincipal: principal,
        action: 'operations.tool-execute',
        operationId,
        toolCallId: 'mux-tool',
        resourceId: operationId,
        attemptExpiresAt: Date.now() + 30_000,
      });
      const dispatchBinding = {
        authorizationId: identity.authorizationId,
        connectionId: 'tab',
        connectionGeneration: 3,
      };
      const request = userRequest(identity, {
        action: 'dispatch',
        operationId,
        attemptId: intent.attemptId,
        dispatchBinding,
        sourceAcceptedVersion: 7,
      });
      await expect(
        authorizeGateway({
          ...request,
          dispatchBinding: { ...dispatchBinding, connectionId: 'wrong' },
        }),
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
      await expect(authorizeGateway({ ...request, generation: 4 })).rejects.toMatchObject({
        code: 'ATTEMPT_CONFLICT',
      });
      await authorizeGateway(request);
      await expect(authorizeGateway(request)).rejects.toMatchObject({ code: 'ATTEMPT_CONFLICT' });
      await expect(authorizeGateway({ ...request, action: 'result' })).resolves.toMatchObject({
        attemptId: intent.attemptId,
      });
      await db.insert(users).values({ id: 'other' });
      await db.update(agentOperations).set({ userId: 'other' });
      for (const action of ['dispatch', 'result'] as const)
        await expect(authorizeGateway({ ...request, action })).rejects.toMatchObject({
          code: 'RESOURCE_NOT_FOUND',
        });
    }));
});

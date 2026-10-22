import { agentOperations, users } from '@lobechat/database/schemas';
import type { TenantScope } from '@lobechat/database/tenant';
import { runWithTenantScope } from '@lobechat/database/tenant';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import { AgentOperationModel } from '@/database/models/agentOperation';
import type { LobeChatDatabase } from '@/database/type';
import { AgentRuntimeCoordinator } from '@/server/modules/AgentRuntime/AgentRuntimeCoordinator';
import { resetRedisClient } from '@/server/modules/Redis';
import { AbandonOperationService } from '@/server/services/agentRuntime/AbandonOperationService';
import { redisService } from '@/server/services/redis';

import { finalizeGatewayOperation } from '../finalize';
import type { GatewayAttemptRecord, GatewayFinalizeRequest } from '../types';

const redisSuite = describe.skipIf(!process.env.GATEWAY_TEST_REDIS_URL);

const state = vi.hoisted(() => ({ db: null as unknown, version: 12, bridge: vi.fn() }));
vi.mock('@/database/core/db-adaptor', () => ({ getServerDB: async () => state.db }));
vi.mock('@/envs/redis', () => ({
  redisEnv: {},
  getRedisConfig: () => ({
    enabled: true,
    prefix: 'gw1017-fix058',
    tls: false,
    url: process.env.GATEWAY_TEST_REDIS_URL,
  }),
}));
vi.mock('@/server/services/agentRuntime/snapshotStore', () => ({
  createDefaultSnapshotStore: () => null,
}));
vi.mock('@/server/services/aiAgent', () => ({
  AiAgentService: class {
    completeSubAgentBridge = state.bridge;
  },
}));

let db: LobeChatDatabase;
const tenantId = 'tenant-E2';
const userId = 'user-E2';
const metadata = (version: number) => ({ tenantId, sourceAcceptedVersion: version });
const run = <T>(fn: () => T, version = state.version) =>
  runWithTenantScope(
    {
      tenantId,
      acceptedVersion: version,
      slug: 'e2',
      endpoint: { basePath: '/t/e2', publicUrl: 'http://test.invalid/t/e2', version: 1 },
      session: { database: db },
    } as TenantScope,
    fn,
  );
const request: GatewayFinalizeRequest = {
  kind: 'operation-watchdog',
  tenancyProtocol: 1,
  tenantId,
  operationId: 'child-E2',
  sourceAcceptedVersion: 10,
  ownerPrincipal: { kind: 'user', id: userId },
  watchdog: { lastEventAt: 1, firedAt: 2 },
};
const row = async (id: string) =>
  (await db.select().from(agentOperations).where(eq(agentOperations.id, id)))[0];
const attempt = async (version: number) => {
  const record: GatewayAttemptRecord = {
    source: { kind: 'operation', operationId: 'parent-E2', subject: userId },
    state: 'claimed',
    intent: {
      tenancyProtocol: 1,
      tenantId,
      sourceAcceptedVersion: version,
      actor: { subject: userId, sourceRef: 'TEST-ONLY' },
      targetPrincipal: { kind: 'user', id: userId },
      action: 'operations.tool-execute',
      operationId: 'parent-E2',
      resourceId: 'parent-E2',
      toolCallId: 'tool-E2',
      attemptId: `parent-${version}-${crypto.randomUUID()}`,
      attemptExpiresAt: Date.now() + 60_000,
    },
  };
  await redisService.gatewayAuthorization.putAttempt(record);
  return record;
};

beforeAll(async () => {
  if (!process.env.GATEWAY_TEST_REDIS_URL?.startsWith('redis://127.0.0.1:'))
    throw new Error('A disposable loopback Redis is required');
  db = await getTestDB();
  state.db = db;
}, 120_000);
beforeEach(async () => {
  vi.restoreAllMocks();
  state.version = 12;
  state.bridge.mockReset();
  vi.spyOn(AgentRuntimeCoordinator.prototype, 'deleteAgentOperation').mockResolvedValue();
  vi.spyOn(AgentRuntimeCoordinator.prototype, 'loadAgentState').mockResolvedValue(null);
  await db.delete(agentOperations);
  await db.delete(users);
  await db.insert(users).values({ id: userId });
  await db.insert(agentOperations).values([
    { id: 'parent-E2', userId, status: 'running', metadata: metadata(12) },
    {
      id: 'child-E2',
      userId,
      status: 'running',
      parentOperationId: 'parent-E2',
      metadata: metadata(10),
    },
  ]);
});
afterAll(async () => {
  vi.restoreAllMocks();
  await resetRedisClient();
});

redisSuite('A1 guarded cleanup with real operation rows and Redis attempts', () => {
  it.each([
    { version: 12, status: 'running' as const },
    { version: 12, status: 'done' as const },
    { version: 10, status: 'done' as const },
  ])('keeps the replacement or terminal parent and its waiter: %j', async ({ version, status }) =>
    run(async () => {
      await db
        .update(agentOperations)
        .set({ status, metadata: metadata(version) })
        .where(eq(agentOperations.id, 'parent-E2'));
      const current = await attempt(version);
      const before = await row('parent-E2');
      expect((await finalizeGatewayOperation(request)).outcome).toBe('finalized');
      expect(await row('parent-E2')).toEqual(before);
      expect((await row('child-E2')).status).toBe('error');
      expect(await redisService.gatewayAuthorization.getAttempt(current.intent.attemptId)).toEqual(
        current,
      );
    }),
  );
  it('only interrupts the original parent execution and its original waiter', async () =>
    run(async () => {
      await db
        .update(agentOperations)
        .set({ metadata: metadata(10), status: 'waiting_for_async_tool' })
        .where(eq(agentOperations.id, 'parent-E2'));
      const original = await attempt(10);
      const replacement = await attempt(12);
      await finalizeGatewayOperation(request);
      expect((await row('parent-E2')).status).toBe('interrupted');
      expect(
        (await redisService.gatewayAuthorization.getAttempt(original.intent.attemptId))?.state,
      ).toBe('executionUnknown');
      expect(
        await redisService.gatewayAuthorization.getAttempt(replacement.intent.attemptId),
      ).toEqual(replacement);
    }));
  it.each(['version', 'link'] as const)(
    'rechecks the parent version and original child link after cleanup: %s',
    async (change) =>
      run(async () => {
        await db
          .update(agentOperations)
          .set({ metadata: metadata(10) })
          .where(eq(agentOperations.id, 'parent-E2'));
        const original = AbandonOperationService.prototype.finalizeAbandoned;
        vi.spyOn(AbandonOperationService.prototype, 'finalizeAbandoned').mockImplementation(
          async function (this: AbandonOperationService, ...args) {
            const result = await original.apply(this, args);
            await db
              .update(agentOperations)
              .set(
                change === 'version'
                  ? { metadata: metadata(12) }
                  : { parentOperationId: 'another-parent' },
              )
              .where(eq(agentOperations.id, change === 'version' ? 'parent-E2' : 'child-E2'));
            return result;
          },
        );
        await finalizeGatewayOperation(request);
        expect((await row('parent-E2')).status).toBe('running');
        expect((await row('parent-E2')).metadata).toEqual(metadata(change === 'version' ? 12 : 10));
      }),
  );
  it.each([false, true])(
    'does not equate found/snapshot-finalized=%s with a terminal durable row',
    async (finalized) =>
      run(async () => {
        vi.spyOn(AbandonOperationService.prototype, 'finalizeAbandoned').mockResolvedValue({
          found: true,
          finalized,
          assistantMessageUpdated: false,
        });
        const pending = await attempt(12);
        expect((await finalizeGatewayOperation(request)).outcome).toBe('still_running');
        expect((await row('child-E2')).status).toBe('running');
        expect((await row('parent-E2')).status).toBe('running');
        expect(
          await redisService.gatewayAuthorization.getAttempt(pending.intent.attemptId),
        ).toEqual(pending);
      }),
  );
  it('refuses a child whose version changed before cleanupOnly performs its write', async () =>
    run(async () => {
      const original = AbandonOperationService.prototype.finalizeAbandoned;
      vi.spyOn(AbandonOperationService.prototype, 'finalizeAbandoned').mockImplementation(
        async function (this: AbandonOperationService, ...args) {
          await db
            .update(agentOperations)
            .set({ metadata: metadata(12) })
            .where(eq(agentOperations.id, 'child-E2'));
          return original.apply(this, args);
        },
      );
      expect((await finalizeGatewayOperation(request)).outcome).toBe('still_running');
      expect((await row('child-E2')).status).toBe('running');
      expect((await row('parent-E2')).status).toBe('running');
    }));
  it.each([
    { version: 12, status: 'running' as const },
    { version: 10, status: 'done' as const },
  ])('does not bridge into a newer or terminal parent: %j', async ({ version, status }) =>
    run(async () => {
      await db
        .update(agentOperations)
        .set({ metadata: metadata(version), status })
        .where(eq(agentOperations.id, 'parent-E2'));
      vi.spyOn(AbandonOperationService.prototype, 'finalizeAbandoned').mockImplementation(
        async () => {
          await db
            .update(agentOperations)
            .set({ status: 'error' })
            .where(eq(agentOperations.id, 'child-E2'));
          return {
            abandoned: true,
            finalized: false,
            found: true,
            assistantMessageUpdated: false,
            subAgentResume: {
              parentOperationId: 'parent-E2',
              errorMessage: 'watchdog',
              threadId: 'thread',
              toolMessageId: 'tool',
              userId,
            },
          };
        },
      );
      await finalizeGatewayOperation(request);
      expect(state.bridge).not.toHaveBeenCalled();
    }, 10),
  );
  it.each([
    {
      childVersion: 10,
      childParent: 'parent-E2',
      status: 'waiting_for_async_tool' as const,
      won: true,
    },
    {
      childVersion: 12,
      childParent: 'parent-E2',
      status: 'waiting_for_async_tool' as const,
      won: false,
    },
    {
      childVersion: 10,
      childParent: 'another-parent',
      status: 'waiting_for_async_tool' as const,
      won: false,
    },
    { childVersion: 10, childParent: 'parent-E2', status: 'done' as const, won: false },
  ])(
    'checks child linkage, version and parent state in the final resume CAS: %j',
    async ({ childVersion, childParent, status, won }) =>
      run(async () => {
        await db
          .update(agentOperations)
          .set({ metadata: metadata(10), status })
          .where(eq(agentOperations.id, 'parent-E2'));
        await db
          .update(agentOperations)
          .set({ metadata: metadata(childVersion), parentOperationId: childParent })
          .where(eq(agentOperations.id, 'child-E2'));
        expect(
          await new AgentOperationModel(db, userId).tryResumeFromAsyncTool('parent-E2', 'child-E2'),
        ).toBe(won);
      }, 10),
  );
  it('atomically refuses the async-tool resume CAS for a parent from another version', async () =>
    run(async () => {
      state.version = 10;
      await db
        .update(agentOperations)
        .set({ status: 'waiting_for_async_tool' })
        .where(eq(agentOperations.id, 'parent-E2'));
      expect(await new AgentOperationModel(db, userId).tryResumeFromAsyncTool('parent-E2')).toBe(
        false,
      );
      expect((await row('parent-E2')).status).toBe('waiting_for_async_tool');
    }, 10));
});

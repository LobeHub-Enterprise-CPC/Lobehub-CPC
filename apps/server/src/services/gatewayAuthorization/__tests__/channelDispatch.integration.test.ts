// @vitest-environment node
import {
  channelJobs,
  channelMembers,
  channelRuns,
  channels,
} from '@lobechat/database/privateSchemas';
import { devices, session, users } from '@lobechat/database/schemas';
import type { TenantScope } from '@lobechat/database/tenant';
import { runWithTenantScope } from '@lobechat/database/tenant';
import { eq } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import { ChannelModel } from '@/database/models/channel';
import type { LobeChatDatabase } from '@/database/type';
import { ChannelDevice } from '@/server/services/channel/device';
import { ChannelWorker } from '@/server/services/channel/worker';
import { deviceGatewayTenancy } from '@/server/services/deviceGateway/tenancy';

import { createGatewayAttempt } from '../attempts';
import { runWithGatewaySource } from '../context';
import { mintGatewayTicket } from '../index';
import { assertGatewaySource } from '../sources';
import type { GatewayAttemptRecord, GatewayAuthorizationSource } from '../types';

const state = vi.hoisted(() => ({
  database: null as unknown,
  attempts: [] as GatewayAttemptRecord[],
}));
vi.mock('@/database/core/db-adaptor', () => ({ getServerDB: async () => state.database }));
vi.mock('@lobechat/business-auth', () => ({
  assertBusinessUserAccess: async () => {},
  isBusinessAuthorizationError: () => false,
}));
vi.mock('@/server/modules/Tenant/runtime', () => ({
  getTenantRuntime: () => ({
    gatewayAdmission: async () => ({ acceptedVersion: 7, effectiveState: 'active' }),
  }),
}));
vi.mock('@/server/services/channel/gate', () => ({ isChannelEnabled: async () => true }));
vi.mock('@/server/services/channel/serverDefault', () => ({
  beginChannelServerDefaultOperation: async () => undefined,
  settleChannelServerDefaultOperation: async () => {},
}));
vi.mock('@/server/services/redis', () => ({
  redisService: {
    gatewayAuthorization: {
      putAttempt: async (record: GatewayAttemptRecord) => state.attempts.push(record),
    },
  },
}));
vi.mock('@/server/services/deviceGateway', () => ({
  isPathWithinRoot: (root: string, path: string) => path === root || path.startsWith(`${root}/`),
  deviceGateway: {
    executeToolCall: async (
      params: { userId: string; deviceId: string },
      _tool: { apiName: string; arguments: string },
    ) => {
      try {
        await deviceGatewayTenancy().prepareDispatch!({
          action: 'device.tool-call',
          resourceId: params.deviceId,
          targetPrincipal: { kind: 'user', id: params.userId },
        });
        return {
          success: true,
          content: JSON.stringify({
            available: true,
            protocol: 'channel-v1',
            canonicalPath: '/repo',
          }),
        };
      } catch (error) {
        return { success: false, error: (error as Error).message, content: '' };
      }
    },
  },
}));

let db: LobeChatDatabase;
let model: ChannelModel;
let job: typeof channelJobs.$inferSelect;
let member: typeof channelMembers.$inferSelect;
let channelId: string;
const owner = 'channel-owner';
const principal = { kind: 'user' as const, id: owner };
const inTenant = <T>(fn: () => T, tenantId = 'tenant-channel') =>
  runWithTenantScope(
    {
      tenantId,
      acceptedVersion: 7,
      slug: 'channel-test',
      session: { database: db },
    } as TenantScope,
    fn,
  );
const adapter = () =>
  new ChannelDevice(db, owner, 'channel-device', {
    jobId: job.id,
    environmentRevision: member.environmentRevision,
  });
const verify = (source: GatewayAuthorizationSource) =>
  assertGatewaySource(source, {
    principal,
    execute: true,
    action: 'device.tool-call',
    resourceId: 'channel-device',
  });

beforeAll(async () => {
  if (process.env.TEST_SERVER_DB === '1' || process.env.DATABASE_TEST_URL)
    throw new Error('Channel authorization tests require disposable PGlite');
  db = await getTestDB();
  state.database = db;
}, 120_000);
beforeEach(async () => {
  state.attempts.length = 0;
  await db.delete(channels);
  await db.delete(users);
  await db.insert(users).values({ id: owner });
  await db.insert(devices).values({
    userId: owner,
    deviceId: 'channel-device',
    identitySource: 'fallback',
    workingDirs: [{ path: '/repo' }],
  });
  model = new ChannelModel(db, owner);
  const channel = await model.create('Authorization regression', [
    {
      name: 'Device',
      config: {
        runtime: 'codex',
        model: '',
        provider: 'codex',
        deviceId: 'channel-device',
        workingDirectory: '/repo',
      },
    },
    { name: 'Peer', config: { runtime: 'native', model: 'fixture', provider: 'fixture' } },
  ]);
  channelId = channel.id;
  member = (await model.detail(channelId)).members.find((item) => item.name === 'Device')!;
  await model.send(channelId, {
    content: 'Run once',
    mentions: [member.id],
    requestKey: 'request',
  });
  [job] = await db.select().from(channelJobs).where(eq(channelJobs.channelId, channelId));
});

describe('Channel background device authority', () => {
  it('probes queued work without a browser session or a fabricated agent operation', async () =>
    inTenant(async () => {
      await expect(adapter().probe('/repo')).resolves.toBe('/repo');
      expect(state.attempts).toHaveLength(1);
      expect(state.attempts[0].source.kind).toBe('channel');
      expect(state.attempts[0].intent.operationId).toBeUndefined();
      await expect(verify(state.attempts[0].source)).resolves.toBeGreaterThan(Date.now());
    }));

  it('advances the real worker from its queued job to a dispatched device run', async () =>
    inTenant(async () => {
      const worker = new ChannelWorker(db);
      try {
        await worker.tick();
        const [updated] = await db.select().from(channelJobs).where(eq(channelJobs.id, job.id));
        expect(updated.status).toBe('running');
        expect(updated.blockedReason).toBeNull();
        expect(state.attempts.map((item) => item.source.kind)).toEqual(['channel', 'channel']);
      } finally {
        await worker.close();
      }
    }));

  it('does not elevate an HTTP context whose gateway credentials are missing', async () =>
    inTenant(async () => {
      await expect(runWithGatewaySource(undefined, () => adapter().probe('/repo'))).rejects.toThrow(
        'SOURCE_UNVERIFIABLE',
      );
      expect(state.attempts).toHaveLength(0);
    }));

  it('retains an authenticated HTTP source instead of replacing it with worker authority', async () =>
    inTenant(async () => {
      await db.insert(session).values({
        id: 'session',
        userId: owner,
        token: 'TEST-ONLY',
        expiresAt: new Date(Date.now() + 60_000),
        updatedAt: new Date(),
      });
      const source = { kind: 'session' as const, sessionId: 'session', subject: owner };
      await runWithGatewaySource(source, () => adapter().probe('/repo'));
      expect(state.attempts[0].source).toEqual(source);
    }));

  it.each(['cancelled', 'archived', 'inactive', 'paused', 'environment', 'banned'] as const)(
    'revokes a queued probe after %s changes',
    async (change) =>
      inTenant(async () => {
        await adapter().probe('/repo');
        const source = state.attempts[0].source;
        if (change === 'cancelled')
          await db
            .update(channelJobs)
            .set({ status: 'cancelled' })
            .where(eq(channelJobs.id, job.id));
        if (change === 'archived')
          await db.update(channels).set({ archived: true }).where(eq(channels.id, channelId));
        if (change === 'inactive')
          await db
            .update(channelMembers)
            .set({ active: false })
            .where(eq(channelMembers.id, member.id));
        if (change === 'paused')
          await db
            .update(channelMembers)
            .set({ executionPaused: true })
            .where(eq(channelMembers.id, member.id));
        if (change === 'environment')
          await db
            .update(channelMembers)
            .set({ environmentRevision: member.environmentRevision + 1 })
            .where(eq(channelMembers.id, member.id));
        if (change === 'banned')
          await db.update(users).set({ banned: true }).where(eq(users.id, owner));
        await expect(verify(source)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
      }),
  );

  it('rejects another tenant, owner, device, or a non-device authorization', async () =>
    inTenant(async () => {
      await adapter().probe('/repo');
      const source = state.attempts[0].source;
      await expect(inTenant(() => verify(source), 'other-tenant')).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
      await expect(verify({ ...source, subject: 'other-owner' })).rejects.toBeDefined();
      await expect(assertGatewaySource(source, { principal, execute: true })).rejects.toMatchObject(
        { code: 'FORBIDDEN' },
      );
      await expect(
        mintGatewayTicket({
          source,
          audience: 'urn:lobehub:gateway:device',
          principal,
          deviceId: 'channel-device',
          connectionId: 'not-a-channel-socket',
          capabilities: ['device:connect', 'device:respond'],
        }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(
        createGatewayAttempt({
          tenantId: 'tenant-channel',
          sourceAcceptedVersion: 7,
          source,
          targetPrincipal: principal,
          action: 'device.tool-call',
          resourceId: 'other-device',
          attemptExpiresAt: Date.now() + 60_000,
        }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }));

  it('starts, inspects and stops the same persisted execution, including revoked cleanup', async () =>
    inTenant(async () => {
      const claim = (await model.claim(channelId, job.id, member.environmentRevision))!;
      const run = claim.run;
      const device = new ChannelDevice(db, owner, 'channel-device', {
        runId: run.id,
        fence: run.executionFence,
      });
      await device.start({
        cwd: '/repo',
        runId: run.id,
        fence: run.executionFence,
        model: '',
        manifest: run.manifest,
      });
      await device.inspect(run.id, run.executionFence);
      await db
        .update(channelRuns)
        .set({ publicationRevoked: true, cleanupRequested: true })
        .where(eq(channelRuns.id, run.id));
      await db.update(channels).set({ archived: true }).where(eq(channels.id, channelId));
      await device.stop(run.id, run.executionFence);
      expect(state.attempts.map((item) => item.source.kind)).toEqual([
        'channel',
        'channel',
        'channel',
      ]);
      await expect(verify(state.attempts[0].source)).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
      await expect(verify(state.attempts[2].source)).resolves.toBeGreaterThan(Date.now());
      await expect(device.inspect(run.id, run.executionFence + 1)).rejects.toThrow();
      await expect(device.inspect('other-run', run.executionFence)).rejects.toThrow();
      await db
        .update(channelRuns)
        .set({ executionFence: run.executionFence + 1 })
        .where(eq(channelRuns.id, run.id));
      await expect(verify(state.attempts[2].source)).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
    }));
});

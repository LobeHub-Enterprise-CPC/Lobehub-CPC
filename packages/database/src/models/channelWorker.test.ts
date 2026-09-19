// @vitest-environment node
import { readFileSync } from 'node:fs';

import { PGlite } from '@electric-sql/pglite';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { ChannelModel } from '@/database/models/channel';
import type { LobeChatDatabase } from '@/database/type';
import { isChannelEnabled } from '@/server/services/channel/gate';
import { routeChannelMessage } from '@/server/services/channel/router';
import { evaluateChannelAudience } from '@/server/services/channel/speaker';
import { ChannelWorker } from '@/server/services/channel/worker';

import * as schema from '../privateSchemas/channel';

const { probe, start } = vi.hoisted(() => ({ probe: vi.fn(), start: vi.fn() }));
vi.mock('@/server/services/channel/device', () => ({
  ChannelDeviceStartError: class extends Error {},
  ChannelDevice: class {
    probe = probe;
    start = start;
    inspect = async () => null;
  },
}));
vi.mock('@/server/services/channel/gate', () => ({ isChannelEnabled: vi.fn() }));
vi.mock(import('@/server/services/channel/speaker'), async (importOriginal) => ({
  ...(await importOriginal()),
  evaluateChannelAudience: vi.fn(),
}));
vi.mock('@/server/services/channel/native/host', () => ({ runChannelNative: vi.fn() }));
vi.mock('@/server/services/channel/native/capabilities', () => ({
  checkChannelNativeAvailability: vi.fn(),
}));
vi.mock('@/server/services/channel/artifact', () => ({
  resolveChannelArtifactRunIds: async () => [],
}));
vi.mock('@/server/services/channel/serverDefault', () => ({
  settleChannelServerDefaultOperation: vi.fn(),
}));

beforeEach(() => vi.stubEnv('CHANNEL_ROUTER', 'jev'));
afterEach(() => vi.unstubAllEnvs());

async function createDatabase() {
  const client = new PGlite();
  await client.exec(`
    CREATE TABLE users (id text PRIMARY KEY, preference jsonb DEFAULT '{"lab":{"enableChannel":true}}');
    INSERT INTO users (id) VALUES ('blocked'), ('ready');
  `);
  for (const migration of ['0009_channel_mvp.sql', '0010_channel_attachments.sql'])
    await client.exec(
      readFileSync(
        new URL(
          `../../../../../packages/enterprise/src/database/migrations/${migration}`,
          import.meta.url,
        ),
        'utf8',
      ).replaceAll('--> statement-breakpoint', ''),
    );
  return { client, db: drizzle(client, { schema }) as unknown as LobeChatDatabase };
}

it.each(['normal', 'discussion'] as const)(
  'switches %s audiences between legacy and Jev without widening mentions or thread scope',
  async (mode) => {
    vi.clearAllMocks();
    vi.stubEnv('CHANNEL_ROUTER', undefined);
    vi.stubEnv('AI_GATEWAY_API_KEY', '');
    const { client, db } = await createDatabase();
    try {
      const model = new ChannelModel(db, 'ready');
      const channel = await model.create(
        'Optional router',
        ['A', 'B', 'C'].map((name) => ({
          name,
          config: { runtime: 'native', model: 'fixture', provider: 'fixture' },
        })),
      );
      const [a, b, c] = (await model.detail(channel.id)).members;
      vi.mocked(evaluateChannelAudience).mockResolvedValue({
        memberIds: [a.id],
        noReply: false,
        reason: 'Jev selected A',
        diagnostics: { source: 'jev', elapsedMs: 1 },
      });
      const root = await model.send(channel.id, {
        content: 'Only B',
        mentions: [b.id],
        requestKey: 'root',
        mode,
      });
      await routeChannelMessage(model, channel.id, root.id);
      expect((await model.detail(channel.id)).jobs.map((job) => job.memberId)).toEqual([b.id]);
      const thread = await model.branch(channel.id, root.id);

      for (const threadId of [null, thread.id]) {
        const message = await model.send(channel.id, {
          content: 'Continue',
          mentions: [],
          requestKey: `legacy-${threadId}`,
          threadId,
          mode,
        });
        await routeChannelMessage(model, channel.id, message.id);
        const expected = threadId ? [b.id] : [a.id, b.id, c.id];
        const detail = await model.detail(channel.id);
        expect(detail.messages.find((item) => item.id === message.id)?.routingStatus).toBe(
          'assigned',
        );
        expect(
          detail.jobs
            .filter((job) => job.messageId === message.id)
            .map((job) => job.memberId)
            .sort(),
        ).toEqual([...expected].sort());
        if (mode === 'discussion') {
          const discussion = detail.discussions.find((item) => item.id === message.id)!;
          expect(discussion.status).toBe('active');
          expect([...discussion.participantIds].sort()).toEqual([...expected].sort());
        }
      }
      expect(evaluateChannelAudience).not.toHaveBeenCalled();

      vi.stubEnv('CHANNEL_ROUTER', 'jev');
      const selected = await model.send(channel.id, {
        content: 'Only A',
        mentions: [],
        requestKey: 'jev',
        mode,
      });
      await routeChannelMessage(model, channel.id, selected.id);
      expect(
        (await model.detail(channel.id)).jobs
          .filter((job) => job.messageId === selected.id)
          .map((job) => job.memberId),
      ).toEqual([a.id]);
      const directed = await model.send(channel.id, {
        content: 'Only C',
        mentions: [c.id],
        requestKey: 'directed',
        mode,
      });
      await routeChannelMessage(model, channel.id, directed.id);
      expect(
        (await model.detail(channel.id)).jobs
          .filter((job) => job.messageId === directed.id)
          .map((job) => job.memberId),
      ).toEqual([c.id]);

      const queued = await model.send(channel.id, {
        content: 'Queued before disabling Jev',
        mentions: [],
        requestKey: 'switch-off',
        mode,
      });
      vi.stubEnv('CHANNEL_ROUTER', 'rules');
      await routeChannelMessage(model, channel.id, queued.id);
      expect(
        (await model.detail(channel.id)).jobs
          .filter((job) => job.messageId === queued.id)
          .map((job) => job.memberId)
          .sort(),
      ).toEqual([a.id, b.id, c.id].sort());
      expect(evaluateChannelAudience).toHaveBeenCalledOnce();
    } finally {
      await client.close();
    }
  },
  30_000,
);

it('routes past twenty disabled-owner requests and resumes them only after re-enabling', async () => {
  vi.clearAllMocks();
  const { client, db } = await createDatabase();
  try {
    await client.exec(
      `UPDATE users SET preference = '{"lab":{"enableChannel":false}}' WHERE id = 'blocked'`,
    );
    let enabled = false;
    vi.mocked(isChannelEnabled).mockImplementation(
      async (_, owner) => enabled || owner === 'ready',
    );
    vi.mocked(evaluateChannelAudience).mockResolvedValue({
      memberIds: [],
      noReply: true,
      reason: 'No response needed',
      diagnostics: { source: 'jev', elapsedMs: 1 },
    });
    const requests: string[] = [];
    for (const owner of ['blocked', 'ready']) {
      const model = new ChannelModel(db, owner);
      const channel = await model.create(
        owner,
        ['A', 'B'].map((name) => ({
          name,
          config: { runtime: 'native', model: 'fixture', provider: 'fixture' },
        })),
      );
      for (let i = 0; i < (owner === 'blocked' ? 20 : 2); i++) {
        const message = await model.send(channel.id, {
          content: `${owner}-${i}`,
          mentions: [],
          requestKey: `${owner}-${i}`,
        });
        requests.push(message.id);
      }
    }
    const worker = new ChannelWorker(db);
    await worker.tick();
    let messages = await db.select().from(schema.channelMessages);
    expect(messages.find((m) => m.id === requests[20])?.routingStatus).toBe('skipped');
    expect(messages.find((m) => m.id === requests[21])?.routingStatus).toBe('pending');
    expect(
      messages
        .filter((m) => requests.slice(0, 20).includes(m.id))
        .every((m) => m.routingStatus === 'pending'),
    ).toBe(true);
    expect(evaluateChannelAudience).toHaveBeenCalledOnce();
    expect(await db.select().from(schema.channelJobs)).toEqual([]);

    enabled = true;
    await client.exec(
      `UPDATE users SET preference = '{"lab":{"enableChannel":true}}' WHERE id = 'blocked'`,
    );
    await worker.tick();
    messages = await db.select().from(schema.channelMessages);
    expect(messages.find((m) => m.id === requests[0])?.routingStatus).toBe('skipped');
    expect(messages.find((m) => m.id === requests[1])?.routingStatus).toBe('pending');
    expect(evaluateChannelAudience).toHaveBeenCalledTimes(2);
    await worker.close();
  } finally {
    await client.close();
  }
}, 30_000);

it.each(['failure', 'success'] as const)(
  'ignores an old provider %s after stop and retry',
  async (outcome) => {
    vi.clearAllMocks();
    const { client, db } = await createDatabase();
    try {
      const model = new ChannelModel(db, 'ready');
      const channel = await model.create(
        'Retry race',
        ['A', 'B'].map((name) => ({
          name,
          config: { runtime: 'native', model: 'fixture', provider: 'fixture' },
        })),
      );
      const [a, b] = (await model.detail(channel.id)).members;
      const message = await model.send(channel.id, {
        content: 'Help',
        mentions: [],
        requestKey: 'retry',
      });
      let finish!: (value: Awaited<ReturnType<typeof evaluateChannelAudience>>) => void;
      vi.mocked(evaluateChannelAudience).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const routing = routeChannelMessage(model, channel.id, message.id);
      await vi.waitFor(() => expect(evaluateChannelAudience).toHaveBeenCalledOnce());
      await model.stop(channel.id, { threadId: null });
      await model.retryRouting(channel.id, message.id);
      finish({
        memberIds: outcome === 'success' ? [a.id] : [],
        noReply: false,
        reason: 'Old result',
        diagnostics: { source: outcome === 'success' ? 'jev' : 'fallback', elapsedMs: 100 },
      });
      await routing;
      let detail = await model.detail(channel.id);
      expect(detail.messages[0].routingStatus).toBe('pending');
      expect(detail.jobs).toEqual([]);
      expect(
        (await db.select().from(schema.channelOutbox)).filter(
          (row) => row.kind === 'route' && !row.processed,
        ),
      ).toHaveLength(1);

      vi.mocked(evaluateChannelAudience).mockResolvedValueOnce({
        memberIds: [b.id],
        noReply: false,
        reason: 'New result',
        diagnostics: { source: 'jev', elapsedMs: 1 },
      });
      await routeChannelMessage(model, channel.id, message.id);
      detail = await model.detail(channel.id);
      expect(detail.messages[0]).toMatchObject({
        routingStatus: 'assigned',
        routingReason: 'New result',
      });
      expect(detail.jobs.map((job) => job.memberId)).toEqual([b.id]);
      expect(evaluateChannelAudience).toHaveBeenCalledTimes(2);
    } finally {
      await client.close();
    }
  },
  30_000,
);

it.each(['offline', 'disabled'] as const)(
  'scans past a full page of %s jobs, preserves FIFO and revisits them after recovery',
  async (blocked) => {
    vi.clearAllMocks();
    const { client, db } = await createDatabase();
    try {
      let recovered = false;
      vi.mocked(isChannelEnabled).mockImplementation(
        async (_db, ownerId) => recovered || blocked !== 'disabled' || ownerId !== 'blocked',
      );
      probe.mockImplementation(async (cwd: string) => {
        if (!recovered && blocked === 'offline' && cwd === '/blocked')
          throw new Error('DEVICE_OFFLINE');
        return cwd;
      });
      start.mockResolvedValue(undefined);
      for (const owner of ['blocked', 'ready']) {
        const model = new ChannelModel(db, owner);
        const channel = await model.create(owner, [
          {
            name: 'Worker',
            config: {
              runtime: 'codex',
              model: '',
              provider: 'codex',
              deviceId: owner,
              workingDirectory: `/${owner}`,
            },
          },
          { name: 'Peer', config: { runtime: 'native', model: 'fixture', provider: 'fixture' } },
        ]);
        const member = (await model.detail(channel.id)).members.find((m) => m.name === 'Worker')!;
        for (let i = 0; i < (owner === 'blocked' ? 41 : 2); i++) {
          const message = await model.send(channel.id, {
            content: `Request ${i}`,
            mentions: [member.id],
            requestKey: `${owner}-${i}`,
          });
          await db
            .update(schema.channelJobs)
            .set({
              id: `job-${String(owner === 'blocked' ? i : 41 + i).padStart(3, '0')}`,
              // Equal timestamps straddle the page boundary; retain PostgreSQL microseconds.
              createdAt:
                owner === 'blocked'
                  ? sql`'2026-09-14T00:00:00.123456Z'::timestamptz`
                  : sql`'2026-09-14T00:00:00.123457Z'::timestamptz`,
            })
            .where(eq(schema.channelJobs.messageId, message.id));
        }
      }
      const worker = new ChannelWorker(db);
      await worker.tick();
      expect(start).not.toHaveBeenCalled();
      await worker.tick();
      expect(start).toHaveBeenCalledTimes(1);
      expect(start).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/ready' }), undefined);
      expect(
        vi.mocked(isChannelEnabled).mock.calls.filter(([, owner]) => owner === 'blocked'),
      ).toHaveLength(41);
      let jobs = await db.select().from(schema.channelJobs);
      expect(jobs.find((job) => job.id === 'job-041')?.status).toBe('running');
      expect(jobs.find((job) => job.id === 'job-042')?.status).toBe('queued');
      expect(jobs.filter((job) => job.id < 'job-041').every((job) => job.status === 'queued')).toBe(
        true,
      );

      recovered = true;
      await worker.tick();
      jobs = await db.select().from(schema.channelJobs);
      expect(jobs.find((job) => job.id === 'job-000')?.status).toBe('running');
      expect(jobs.find((job) => job.id === 'job-001')?.status).toBe('queued');
      expect(start).toHaveBeenCalledTimes(2);
      await worker.close();
    } finally {
      await client.close();
    }
  },
  30_000,
);

// @vitest-environment node
import { readFileSync } from 'node:fs';

import { PGlite } from '@electric-sql/pglite';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { expect, it, vi } from 'vitest';

import { ChannelModel } from '@/database/models/channel';
import type { LobeChatDatabase } from '@/database/type';
import { isChannelEnabled } from '@/server/services/channel/gate';
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

it.each(['offline', 'disabled'] as const)(
  'scans past a full page of %s jobs, preserves FIFO and revisits them after recovery',
  async (blocked) => {
    vi.clearAllMocks();
    const client = new PGlite();
    try {
      await client.exec(
        "CREATE TABLE users (id text PRIMARY KEY); INSERT INTO users VALUES ('blocked'), ('ready');",
      );
      await client.exec(
        readFileSync(
          // Migration ownership moved to the enterprise chain (see
          // src/privateSchemas/channel.ts) after this test was written.
          new URL(
            '../../../../../packages/enterprise/src/database/migrations/0009_channel_mvp.sql',
            import.meta.url,
          ),
          'utf8',
        ).replaceAll('--> statement-breakpoint', ''),
      );
      const db = drizzle(client, { schema }) as unknown as LobeChatDatabase;
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

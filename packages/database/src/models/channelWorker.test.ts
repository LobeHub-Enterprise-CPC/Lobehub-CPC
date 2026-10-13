// @vitest-environment node
import { PGlite } from '@electric-sql/pglite';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { expect, it, vi } from 'vitest';

import { ChannelModel } from '@/database/models/channel';
import type { LobeChatDatabase } from '@/database/type';
import { isChannelEnabled } from '@/server/services/channel/gate';
import { ChannelWorker } from '@/server/services/channel/worker';

import { channelMigrationSql } from '../../tests/channelMigrations';
import * as schema from '../privateSchemas/channel';

const { probe, start, OfflineError } = vi.hoisted(() => ({
  probe: vi.fn(),
  start: vi.fn(),
  OfflineError: class extends Error {},
}));
vi.mock('@/server/services/channel/device', () => ({
  ChannelDeviceOfflineError: OfflineError,
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

it('probes only idle FIFO heads, backs off offline devices and revisits them after recovery', async () => {
  vi.clearAllMocks();
  const client = new PGlite();
  try {
    await client.exec(
      "CREATE TABLE users (id text PRIMARY KEY); INSERT INTO users VALUES ('blocked'), ('ready');",
    );
    await client.exec(channelMigrationSql());
    const db = drizzle(client, { schema }) as unknown as LobeChatDatabase;
    let recovered = false;
    vi.mocked(isChannelEnabled).mockReturnValue(true);
    probe.mockImplementation(async (cwd: string) => {
      if (!recovered && cwd === '/blocked') throw new OfflineError('DEVICE_OFFLINE');
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
    // Only each idle member's FIFO head is probed: one per member, not one per queued job.
    expect(probe).toHaveBeenCalledTimes(2);
    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/ready' }), undefined);
    await worker.tick();
    // The busy member's later work and the backed-off offline head are not probed again.
    expect(probe).toHaveBeenCalledTimes(2);
    expect(start).toHaveBeenCalledTimes(1);
    let jobs = await db.select().from(schema.channelJobs);
    expect(jobs.find((job) => job.id === 'job-041')?.status).toBe('running');
    expect(jobs.find((job) => job.id === 'job-042')?.status).toBe('queued');
    expect(jobs.filter((job) => job.id < 'job-041').every((job) => job.status === 'queued')).toBe(
      true,
    );
    const unavailable = await db
      .select()
      .from(schema.channelAudit)
      .where(eq(schema.channelAudit.event, 'job_unavailable'));
    expect(unavailable).toHaveLength(1);
    expect(jobs.find((job) => job.id === 'job-000')).toMatchObject({
      blockedCode: 'device_offline',
      blockedReason: 'DEVICE_OFFLINE',
    });

    recovered = true;
    await worker.close();
    // A fresh worker has no probe backoff, like one started after the device reconnects.
    const next = new ChannelWorker(db);
    await next.tick();
    jobs = await db.select().from(schema.channelJobs);
    expect(jobs.find((job) => job.id === 'job-000')?.status).toBe('running');
    expect(jobs.find((job) => job.id === 'job-001')?.status).toBe('queued');
    expect(jobs.find((job) => job.id === 'job-000')?.blockedReason).toBeNull();
    expect(start).toHaveBeenCalledTimes(2);
    await next.close();
  } finally {
    await client.close();
  }
}, 30_000);

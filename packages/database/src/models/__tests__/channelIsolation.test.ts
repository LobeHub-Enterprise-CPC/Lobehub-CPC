// @vitest-environment node
import { randomUUID } from 'node:crypto';

import { PGlite } from '@electric-sql/pglite';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { channelMigrationSql } from '../../../tests/channelMigrations';
import * as schema from '../../privateSchemas/channel';
import type { LobeChatDatabase } from '../../type';
import { ChannelModel } from '../channel';

let client: PGlite;
let db: LobeChatDatabase;
let model: ChannelModel;
const device = {
  model: 'gpt-5-codex',
  provider: 'codex',
  runtime: 'codex' as const,
  deviceId: 'device',
  workingDirectory: '/canonical/fixture',
};
const native = { model: 'deepseek-v4-flash', provider: 'deepseek', runtime: 'native' as const };

beforeAll(async () => {
  client = new PGlite();
  await client.exec(
    "create table users (id text primary key); insert into users values ('owner'), ('other');",
  );
  await client.exec(channelMigrationSql());
  db = drizzle(client, { schema }) as unknown as LobeChatDatabase;
  model = new ChannelModel(db, 'owner');
}, 30_000);
afterAll(async () => client?.close());

async function setup(config: typeof device | typeof native) {
  const channel = await model.create('Isolation', [
    { name: 'Alpha', config },
    { name: 'Beta', config },
  ]);
  const [a, b] = (await model.detail(channel.id)).members;
  return { channel, a, b };
}

const send = (channelId: string, mentions: string[], content = 'Work', mode?: 'discussion') =>
  model.send(channelId, { content, mentions, requestKey: randomUUID(), mode });

const queuedJob = async (channelId: string, memberId: string) =>
  (await model.detail(channelId)).jobs.find(
    (job) => job.memberId === memberId && job.status === 'queued',
  )!;

const runRow = async (id: string) =>
  (await db.select().from(schema.channelRuns).where(eq(schema.channelRuns.id, id)))[0];

const jobRow = async (id: string) =>
  (await db.select().from(schema.channelJobs).where(eq(schema.channelJobs.id, id)))[0];

describe('Channel writer isolation', () => {
  it('frees a member held by the observed failed + unknown device writer, without claiming it stopped', async () => {
    const { channel, a } = await setup(device);
    await send(channel.id, [a.id]);
    const stuck = (await model.claim(channel.id, (await queuedJob(channel.id, a.id)).id))!;
    // The production sequence: unknown device outcome, the execution limit, then another
    // unconfirmed stop. Nothing on this path ever releases the writer.
    await model.executionUnknown(channel.id, stuck.run.id, 1, 'Agent execution did not complete');
    await model.fail(channel.id, stuck.run.id, 1, 'Agent execution exceeded 30 minutes');
    await model.executionUnknown(channel.id, stuck.run.id, 1, 'Agent execution did not complete');
    expect(await runRow(stuck.run.id)).toMatchObject({
      status: 'execution_unknown',
      acceptance: 'pending',
      writerReleased: false,
      physicalStopped: false,
      publicationRevoked: true,
      cleanupRequested: false,
      isolatedAt: null,
    });
    expect((await jobRow(stuck.run.jobId)).status).toBe('failed');

    await send(channel.id, [a.id], 'Next request');
    const next = await queuedJob(channel.id, a.id);
    expect(await model.claim(channel.id, next.id)).toBeNull();

    expect(await model.isolate(channel.id, stuck.run.id, 1, 'Termination was not confirmed')).toBe(
      true,
    );
    expect(await model.isolate(channel.id, stuck.run.id, 1, 'again')).toBe(false);
    expect(await runRow(stuck.run.id)).toMatchObject({
      status: 'execution_unknown',
      writerReleased: false,
      physicalStopped: false,
      publicationRevoked: true,
      isolatedAt: expect.any(Date),
    });
    const [audit] = await db
      .select()
      .from(schema.channelAudit)
      .where(
        and(
          eq(schema.channelAudit.targetId, stuck.run.id),
          eq(schema.channelAudit.event, 'execution_isolated'),
        ),
      );
    expect(audit.details).toMatchObject({
      reason: 'Termination was not confirmed',
      physicalStopped: false,
      jobStatus: 'failed',
    });

    const resumed = (await model.claim(channel.id, next.id))!;
    expect(resumed).not.toBeNull();
    // The unconfirmed writer may still be attached to its native session: start a new one.
    expect(resumed.session.id).not.toBe(stuck.session.id);
    expect(resumed.session.generation).toBe(stuck.session.generation + 1);
    expect(resumed.run.manifest.source).toBe('reconstructed');

    // The isolated writer can never regain publication authority...
    await expect(
      model.accepted(channel.id, stuck.run.id, 1, 'late-session', 'late-turn'),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(model.saveDraft(channel.id, stuck.run.id, 1, 'late')).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    await expect(model.publish(channel.id, stuck.run.id, 1)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    // ...while a later physical confirmation is still recorded as such.
    await model.releaseWriter(channel.id, stuck.run.id, 1);
    await model.recordEnvironmentCleanup(channel.id, stuck.run.id, 1, true);
    expect(await runRow(stuck.run.id)).toMatchObject({
      status: 'stopped',
      writerReleased: true,
      physicalStopped: true,
    });
  });

  it('settles an orphaned native job and starts the member over in a fresh session', async () => {
    const { channel, a } = await setup(native);
    await send(channel.id, [a.id], 'First');
    const orphan = (await model.claim(channel.id, (await queuedJob(channel.id, a.id)).id))!;
    await model.accepted(channel.id, orphan.run.id, 1, 'native-session', 'operation');
    await model.executionUnknown(
      channel.id,
      orphan.run.id,
      1,
      'Native worker disconnected; execution requires inspection',
    );
    // The executor is gone, so the job never leaves running and nothing revokes publication.
    expect((await jobRow(orphan.run.jobId)).status).toBe('running');
    await send(channel.id, [a.id], 'Second');
    expect(await model.claim(channel.id, (await queuedJob(channel.id, a.id)).id)).toBeNull();
    await expect(model.resetSession(channel.id, a.id, null)).rejects.toMatchObject({
      code: 'CONFLICT',
    });

    expect(await model.isolate(channel.id, orphan.run.id, 1, 'Executor disappeared')).toBe(true);
    expect((await jobRow(orphan.run.jobId)).status).toBe('failed');
    expect(await runRow(orphan.run.id)).toMatchObject({
      publicationRevoked: true,
      writerReleased: false,
      physicalStopped: false,
    });
    const next = (await model.claim(channel.id, (await queuedJob(channel.id, a.id)).id))!;
    expect(next.session.nativeSessionId).toBeNull();
    expect(next.run.manifest.source).toBe('reconstructed');
    expect(next.run.manifest.messages.map((message) => message.content)).toEqual([
      'First',
      'Second',
    ]);
  });

  it('leaves released and already isolated writers alone', async () => {
    const { channel, a } = await setup(native);
    await send(channel.id, [a.id]);
    const done = (await model.claim(channel.id, (await queuedJob(channel.id, a.id)).id))!;
    await model.accepted(channel.id, done.run.id, 1, 'native-session', 'operation');
    await model.saveDraft(channel.id, done.run.id, 1, 'Reply');
    await model.publish(channel.id, done.run.id, 1);
    await model.releaseWriter(channel.id, done.run.id, 1);
    expect(await model.isolate(channel.id, done.run.id, 1, 'Not needed')).toBe(false);
    expect(await runRow(done.run.id)).toMatchObject({
      isolatedAt: null,
      publicationRevoked: false,
      publicationStatus: 'published',
    });
    await expect(
      new ChannelModel(db, 'other').isolate(channel.id, done.run.id, 1, 'Foreign'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('lets a discussion round settle once its unconfirmed writer is isolated', async () => {
    const { channel, a, b } = await setup(native);
    await model.send(channel.id, {
      content: 'Discuss',
      mentions: [],
      mode: 'discussion',
      requestKey: randomUUID(),
      maxDiscussionRounds: 2,
    });
    const alpha = (await model.claim(channel.id, (await queuedJob(channel.id, a.id)).id))!;
    const beta = (await model.claim(channel.id, (await queuedJob(channel.id, b.id)).id))!;
    await model.accepted(channel.id, alpha.run.id, 1, 'alpha-session', 'alpha');
    await model.saveDraft(channel.id, alpha.run.id, 1, 'Alpha view');
    expect(await model.publish(channel.id, alpha.run.id, 1)).toEqual(expect.any(String));
    await model.releaseWriter(channel.id, alpha.run.id, 1);
    await model.executionUnknown(channel.id, beta.run.id, 1, 'Native worker disconnected');

    await model.advanceDiscussions(channel.id);
    expect((await model.detail(channel.id)).discussions[0]).toMatchObject({
      status: 'active',
      round: 1,
    });
    await model.isolate(channel.id, beta.run.id, 1, 'Executor disappeared');
    await model.advanceDiscussions(channel.id);
    const detail = await model.detail(channel.id);
    expect(detail.discussions[0]).toMatchObject({ status: 'active', round: 2 });
    const roundTwo = detail.jobs.filter((job) => job.deliveryKey === 'round:2');
    expect(roundTwo.map((job) => job.memberId).sort()).toEqual([a.id, b.id].sort());
    expect(
      await model.claim(channel.id, roundTwo.find((job) => job.memberId === b.id)!.id),
    ).not.toBeNull();
  });
});

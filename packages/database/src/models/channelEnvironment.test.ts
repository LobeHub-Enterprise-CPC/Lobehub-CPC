// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, expect, it } from 'vitest';

import * as schema from '../schemas/channel';
import type { LobeChatDatabase } from '../type';
import { ChannelModel } from './channel';

let client: PGlite;
let db: LobeChatDatabase;
let model: ChannelModel;
const original = {
  agentId: 'codex',
  runtime: 'codex' as const,
  provider: 'codex',
  model: '',
  deviceId: 'mac',
  workingDirectory: '/standalone',
};
beforeAll(async () => {
  client = new PGlite();
  await client.exec(
    "CREATE TABLE users (id text PRIMARY KEY); INSERT INTO users VALUES ('owner'), ('other');",
  );
  for (const file of ['0163_channel_mvp'])
    await client.exec(
      readFileSync(new URL(`../../migrations/${file}.sql`, import.meta.url), 'utf8').replaceAll(
        '--> statement-breakpoint',
        '',
      ),
    );
  db = drizzle(client, { schema }) as unknown as LobeChatDatabase;
  model = new ChannelModel(db, 'owner');
}, 30_000);
afterAll(async () => client?.close());

async function setup() {
  const channel = await model.create('Environment', [
    { name: 'Codex', config: original },
    { name: 'Reviewer', config: { runtime: 'native', model: 'fixture', provider: 'fixture' } },
  ]);
  const member = (await model.detail(channel.id)).members.find(
    (m) => m.config.agentId === 'codex',
  )!;
  return { channel, member };
}
async function send(channelId: string, memberId: string, threadId?: string) {
  const message = await model.send(channelId, {
    content: 'Edit files',
    mentions: [memberId],
    requestKey: randomUUID(),
    threadId,
  });
  return (await model.detail(channelId)).jobs.find(
    (j) => j.memberId === memberId && j.messageId === message.id,
  )!;
}
async function storedRun(runId: string) {
  const [run] = await db.select().from(schema.channelRuns).where(eq(schema.channelRuns.id, runId));
  return run;
}

it('pauses an idle member without confirmation and blocks later claims', async () => {
  const { channel, member } = await setup();

  await expect(model.pauseMember(channel.id, member.id, 0, true)).resolves.toEqual({
    confirmationRequired: false,
  });
  const job = await send(channel.id, member.id);

  expect(
    (await model.detail(channel.id)).members.find((candidate) => candidate.id === member.id)
      ?.executionPaused,
  ).toBe(true);
  await expect(model.claim(channel.id, job.id, 0)).resolves.toBeNull();
});

it('requires confirmation for queued work without cancelling it, even when already paused', async () => {
  const active = await setup();
  const activeJob = await send(active.channel.id, active.member.id);

  await expect(model.pauseMember(active.channel.id, active.member.id, 0, true)).resolves.toEqual({
    confirmationRequired: true,
  });
  let detail = await model.detail(active.channel.id);
  expect(detail.members.find((member) => member.id === active.member.id)?.executionPaused).toBe(
    false,
  );
  expect(detail.jobs.find((job) => job.id === activeJob.id)?.status).toBe('queued');

  const paused = await setup();
  await model.pauseMember(paused.channel.id, paused.member.id, 0);
  const pausedJob = await send(paused.channel.id, paused.member.id);
  await expect(model.pauseMember(paused.channel.id, paused.member.id, 0, true)).resolves.toEqual({
    confirmationRequired: true,
  });
  detail = await model.detail(paused.channel.id);
  expect(detail.members.find((member) => member.id === paused.member.id)?.executionPaused).toBe(
    true,
  );
  expect(detail.jobs.find((job) => job.id === pausedJob.id)?.status).toBe('queued');
});

it('leaves a running job untouched until an explicit confirmed pause', async () => {
  const { channel, member } = await setup();
  const job = await send(channel.id, member.id);
  const { run } = (await model.claim(channel.id, job.id, 0))!;

  await expect(model.pauseMember(channel.id, member.id, 0, true)).resolves.toEqual({
    confirmationRequired: true,
  });
  let detail = await model.detail(channel.id);
  expect(detail.members.find((candidate) => candidate.id === member.id)?.executionPaused).toBe(
    false,
  );
  expect(detail.jobs.find((candidate) => candidate.id === job.id)?.status).toBe('running');
  expect(detail.runs.find((candidate) => candidate.id === run.id)).toMatchObject({
    physicalStopped: false,
    publicationRevoked: false,
    status: 'starting',
    writerReleased: false,
  });
  expect((await storedRun(run.id)).cleanupRequested).toBe(false);

  await expect(model.pauseMember(channel.id, member.id, 0)).resolves.toEqual({
    confirmationRequired: false,
  });
  detail = await model.detail(channel.id);
  expect(detail.members.find((candidate) => candidate.id === member.id)?.executionPaused).toBe(
    true,
  );
  expect(detail.jobs.find((candidate) => candidate.id === job.id)?.status).toBe('cancelled');
  expect(detail.runs.find((candidate) => candidate.id === run.id)).toMatchObject({
    physicalStopped: false,
    publicationRevoked: true,
    status: 'stop_requested',
    writerReleased: false,
  });
  expect((await storedRun(run.id)).cleanupRequested).toBe(true);
});

it('requires confirmation when the writer is released but physical execution is not stopped', async () => {
  const { channel, member } = await setup();
  const job = await send(channel.id, member.id);
  const { run } = (await model.claim(channel.id, job.id, 0))!;
  await model.accepted(channel.id, run.id, 1, 'session', 'turn');
  await model.saveDraft(channel.id, run.id, 1, 'Done');
  await model.publish(channel.id, run.id, 1);
  await model.releaseWriter(channel.id, run.id, 1);

  await expect(model.pauseMember(channel.id, member.id, 0, true)).resolves.toEqual({
    confirmationRequired: true,
  });
  const detail = await model.detail(channel.id);
  expect(detail.members.find((candidate) => candidate.id === member.id)?.executionPaused).toBe(
    false,
  );
  expect(detail.jobs.find((candidate) => candidate.id === job.id)?.status).toBe('completed');
  expect(detail.runs.find((candidate) => candidate.id === run.id)).toMatchObject({
    physicalStopped: false,
    publicationRevoked: false,
    status: 'completed',
    writerReleased: true,
  });
  expect((await storedRun(run.id)).cleanupRequested).toBe(false);
});

it('isolates the same Agent across Channels, resets every session and cancels old queued instructions', async () => {
  const { channel, member } = await setup();
  const other = await setup();
  const main = await send(channel.id, member.id);
  const first = (await model.claim(channel.id, main.id, 0))!;
  await model.accepted(channel.id, first.run.id, 1, 'mac-session-main', 'turn-main');
  await model.saveDraft(channel.id, first.run.id, 1, 'Main reply');
  await model.publish(channel.id, first.run.id, 1);
  await model.releaseWriter(channel.id, first.run.id, 1);
  const thread = await model.branch(channel.id, main.messageId);
  const threadJob = await send(channel.id, member.id, thread.id);
  const second = (await model.claim(channel.id, threadJob.id, 0))!;
  await model.accepted(channel.id, second.run.id, 1, 'mac-session-thread', 'turn-thread');
  await model.fail(
    channel.id,
    second.run.id,
    1,
    'A failed tool may still have background processes',
  );
  await model.releaseWriter(channel.id, second.run.id, 1);
  const queued = await send(channel.id, member.id);
  const publicBefore = (await model.detail(channel.id)).messages;
  await model.pauseMember(channel.id, member.id, 0);
  await expect(model.claim(channel.id, queued.id, 0)).resolves.toBeNull();
  await expect(
    model.updateEnvironment(channel.id, member.id, 0, {
      deviceId: 'linux',
      workingDirectory: '/channel-one',
    }),
  ).rejects.toThrow('confirmed stopped');
  // Released completed/failed writers still require independent physical confirmation.
  await model.recordEnvironmentCleanup(channel.id, first.run.id, 1, true);
  await model.recordEnvironmentCleanup(channel.id, second.run.id, 1, false, 'Device offline');
  await expect(
    model.updateEnvironment(channel.id, member.id, 0, {
      deviceId: 'linux',
      workingDirectory: '/channel-one',
    }),
  ).rejects.toThrow('confirmed stopped');
  await model.recordEnvironmentCleanup(channel.id, second.run.id, 1, true);
  await model.updateEnvironment(channel.id, member.id, 0, {
    deviceId: 'linux',
    workingDirectory: '/channel-one',
  });
  const detail = await model.detail(channel.id);
  expect(detail.members.find((m) => m.id === member.id)).toMatchObject({
    environmentRevision: 1,
    executionPaused: false,
    config: { deviceId: 'linux', workingDirectory: '/channel-one' },
  });
  expect(detail.messages).toEqual(publicBefore);
  expect(detail.jobs.find((j) => j.id === queued.id)?.status).toBe('cancelled');
  expect(detail.runs.map((r) => r.executionConfig)).toEqual([original, original]);
  expect(
    (await model.detail(other.channel.id)).members.find((m) => m.id === other.member.id)?.config,
  ).toEqual(original);
  const sessions = await db
    .select()
    .from(schema.channelSessions)
    .where(eq(schema.channelSessions.memberId, member.id));
  expect(sessions.filter((s) => !s.scope.startsWith('archived:'))).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        scope: 'main',
        generation: 2,
        nativeSessionId: null,
        acceptedMessageIds: [],
      }),
      expect.objectContaining({
        scope: thread.id,
        generation: 2,
        nativeSessionId: null,
        acceptedMessageIds: [],
      }),
    ]),
  );
  const fresh = await send(channel.id, member.id);
  // A probe performed against the old revision cannot claim new work.
  await expect(model.claim(channel.id, fresh.id, 0)).resolves.toBeNull();
  const claim = (await model.claim(channel.id, fresh.id, 1))!;
  expect(claim.run.executionConfig).toMatchObject({
    deviceId: 'linux',
    workingDirectory: '/channel-one',
  });
  expect(claim.run.manifest.source).toBe('reconstructed');
  expect(claim.session.nativeSessionId).toBeNull();
  expect(claim.run.manifest.messages.map((m) => m.id)).toContain(main.messageId);
  await expect(model.pauseMember(channel.id, member.id, 0)).rejects.toMatchObject({
    code: 'CONFLICT',
  });
  await expect(
    new ChannelModel(db, 'other').pauseMember(channel.id, member.id, 1),
  ).rejects.toMatchObject({ code: 'NOT_FOUND' });
});

it('keeps cleanup durable after cancelling a switch, without replaying an interrupted run', async () => {
  const { channel, member } = await setup();
  const job = await send(channel.id, member.id);
  const { run } = (await model.claim(channel.id, job.id, 0))!;
  await model.releaseWriter(channel.id, run.id, 1);
  await model.pauseMember(channel.id, member.id, 0);
  const queued = await send(channel.id, member.id);
  await model.resumeMember(channel.id, member.id, 0);
  expect((await model.detail(channel.id)).jobs.find((j) => j.id === queued.id)?.status).toBe(
    'queued',
  );
  expect(await model.claim(channel.id, queued.id, 0)).toBeNull();
  await model.recordEnvironmentCleanup(channel.id, run.id, 1, true);
  expect((await model.claim(channel.id, queued.id, 0))?.run.executionConfig).toEqual(original);
});

it('does not deliver a delayed routing result into the new environment', async () => {
  const { channel, member } = await setup();
  const job = await send(channel.id, member.id);
  await db.delete(schema.channelJobs).where(eq(schema.channelJobs.id, job.id));
  await db
    .update(schema.channelMessages)
    .set({ routingStatus: 'pending' })
    .where(eq(schema.channelMessages.id, job.messageId));
  await model.pauseMember(channel.id, member.id, 0);
  await model.updateEnvironment(channel.id, member.id, 0, {
    deviceId: 'mac',
    workingDirectory: '/another-channel',
  });
  await model.assign(channel.id, job.messageId, {
    memberIds: [member.id],
    reason: 'Delayed old router result',
  });
  expect((await model.detail(channel.id)).jobs).toHaveLength(0);
});

it('rejects environment edits for native members and rejects saving without a durable pause', async () => {
  const { channel, member } = await setup();
  const native = (await model.detail(channel.id)).members.find(
    (m) => m.config.runtime === 'native',
  )!;
  await expect(model.pauseMember(channel.id, native.id, 0)).rejects.toMatchObject({
    code: 'BAD_REQUEST',
  });
  await expect(
    model.updateEnvironment(channel.id, member.id, 0, {
      deviceId: 'mac',
      workingDirectory: '/other',
    }),
  ).rejects.toMatchObject({ code: 'CONFLICT' });
});

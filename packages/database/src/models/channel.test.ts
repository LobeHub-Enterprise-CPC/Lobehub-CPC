// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import * as schema from '../schemas/channel';
import type { LobeChatDatabase } from '../type';
import { ChannelModel } from './channel';

let client: PGlite;
let db: LobeChatDatabase;
let model: ChannelModel;
const config = { model: 'deepseek-v4-flash', provider: 'deepseek', runtime: 'native' as const };
const members = [
  { name: 'Reviewer', config },
  { name: 'Builder', config },
];

beforeAll(async () => {
  client = new PGlite();
  await client.exec(
    "create table users (id text primary key); insert into users values ('owner'), ('other');",
  );
  await client.exec(
    readFileSync(
      new URL('../../migrations/0159_channel_mvp.sql', import.meta.url),
      'utf8',
    ).replaceAll('--> statement-breakpoint', ''),
  );
  db = drizzle(client, { schema }) as unknown as LobeChatDatabase;
  model = new ChannelModel(db, 'owner');
}, 30000);
afterAll(async () => client?.close());

async function setup(workspace = false) {
  const c = await model.create(
    'Channel test',
    workspace
      ? members.map((m) => ({
          ...m,
          config: { ...m.config, deviceId: 'device', workingDirectory: '/canonical/fixture' },
        }))
      : members,
  );
  const detail = await model.detail(c.id);
  return { c, a: detail.members[0], b: detail.members[1] };
}

describe('Channel durable boundaries', () => {
  it('keeps one membership per existing Agent and permits rejoining after removal', async () => {
    const original = { name: 'Existing Agent', config: { ...config, agentId: 'owned-agent' } };
    const channel = await model.create('References', [original]);
    await expect(model.addMembers(channel.id, [original])).rejects.toThrow('already a member');
    const first = (await model.detail(channel.id)).members[0];
    await model.retire(channel.id, first.id);
    await model.addMembers(channel.id, [original]);
    expect((await model.detail(channel.id)).members.filter((m) => m.active)).toHaveLength(1);
  });

  it('atomically retains messages and jobs, deduplicates retries and denies another owner', async () => {
    const { c, a } = await setup();
    const input = { content: 'Implement it', mentions: [a.id], requestKey: randomUUID() };
    const first = await model.send(c.id, input);
    expect((await model.send(c.id, input)).id).toBe(first.id);
    await expect(
      model.send(c.id, { ...input, content: 'Different request' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    const detail = await model.detail(c.id);
    expect(detail.messages).toHaveLength(1);
    expect(detail.jobs).toHaveLength(1);
    expect(detail.runs).toHaveLength(0);
    await expect(new ChannelModel(db, 'other').detail(c.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(
      (
        await db.select().from(schema.channelOutbox).where(eq(schema.channelOutbox.channelId, c.id))
      ).map((x) => x.kind),
    ).toEqual(['execute']);
  });

  it('broadcasts atomically to every active member exactly once without a router', async () => {
    const { c, a, b } = await setup();
    const input = { content: '有人吗', mentions: [], requestKey: randomUUID() };
    const message = await model.send(c.id, input);
    await model.send(c.id, input);
    await model.recall(c.id, message.id, a.id);
    expect(await model.routingInput(c.id, message.id)).toBeNull();
    expect(await model.assign(c.id, message.id, { memberId: b.id, reason: 'Late router' })).toBe(
      false,
    );
    const detail = await model.detail(c.id);
    expect(detail.messages).toHaveLength(1);
    expect(detail.jobs.map((job) => job.memberId).sort()).toEqual([a.id, b.id].sort());
    expect(detail.messages[0]).toMatchObject({ routingStatus: 'assigned', mentions: [] });
    expect(
      (
        await db.select().from(schema.channelOutbox).where(eq(schema.channelOutbox.channelId, c.id))
      ).map((row) => row.kind),
    ).toEqual(['execute', 'execute']);
  });

  it('uses the same request cutoff for every reply, even when another reply is published first', async () => {
    const { c, a, b } = await setup();
    const request = await model.send(c.id, {
      content: 'Everyone reply',
      mentions: [],
      requestKey: randomUUID(),
    });
    const jobs = (await model.detail(c.id)).jobs;
    const first = (await model.claim(c.id, jobs.find((job) => job.memberId === a.id)!.id))!;
    await model.accepted(c.id, first.run.id, 1, 'first-session', 'first-turn');
    await model.saveDraft(c.id, first.run.id, 1, 'First response');
    await model.publish(c.id, first.run.id, 1);
    await model.releaseWriter(c.id, first.run.id, 1);
    const second = (await model.claim(c.id, jobs.find((job) => job.memberId === b.id)!.id))!;
    expect(second.run.manifest.cutoffSequence).toBe(request.sequence);
    expect(second.run.manifest.messages).toEqual(first.run.manifest.messages);
    expect((await model.detail(c.id)).jobs).toHaveLength(2);
  });

  it('keeps unavailable members visible without blocking other recipients', async () => {
    const { c, a, b } = await setup();
    await model.send(c.id, { content: '有人吗', mentions: [], requestKey: randomUUID() });
    const jobs = (await model.detail(c.id)).jobs;
    await model.unavailable(c.id, jobs.find((job) => job.memberId === a.id)!.id, 'DEVICE_OFFLINE');
    const second = await model.claim(c.id, jobs.find((job) => job.memberId === b.id)!.id);
    expect(second).not.toBeNull();
    expect(
      (await model.detail(c.id)).jobs.find((job) => job.memberId === a.id)?.blockedReason,
    ).toBe('DEVICE_OFFLINE');
    await model.unavailable(c.id, jobs.find((job) => job.memberId === a.id)!.id, null);
    expect(
      (await model.detail(c.id)).jobs.find((job) => job.memberId === a.id)?.blockedReason,
    ).toBeNull();
  });

  it('excludes removed members and limits explicit mentions to named recipients', async () => {
    const { c, a, b } = await setup();
    await model.send(c.id, { content: 'Only B', mentions: [b.id], requestKey: randomUUID() });
    await model.retire(c.id, b.id);
    const request = await model.send(c.id, {
      content: 'Everyone',
      mentions: [],
      requestKey: randomUUID(),
    });
    const jobs = (await model.detail(c.id)).jobs;
    expect(jobs.filter((job) => job.messageId === request.id).map((job) => job.memberId)).toEqual([
      a.id,
    ]);
    expect(jobs).toHaveLength(2);
  });

  it('forks the authorized public prefix and reuses roots without replaying future history', async () => {
    const { c, a } = await setup();
    const root = await model.send(c.id, {
      content: 'Root context',
      mentions: [],
      requestKey: randomUUID(),
    });
    await model.send(c.id, {
      content: 'Future main secret',
      mentions: [],
      requestKey: randomUUID(),
    });
    await model.stop(c.id, { threadId: null });
    const thread = await model.branch(c.id, root.id);
    expect((await model.branch(c.id, root.id)).id).toBe(thread.id);
    const reply = await model.send(c.id, {
      content: 'Branch request',
      mentions: [a.id],
      threadId: thread.id,
      requestKey: randomUUID(),
    });
    await expect(model.branch(c.id, reply.id)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    const job = (await model.detail(c.id)).jobs.find((job) => job.messageId === reply.id)!;
    const claim = await model.claim(c.id, job.id);
    expect(claim?.run.manifest.messages.map((m) => m.content)).toEqual([
      'Root context',
      'Branch request',
    ]);
    expect(claim?.run.manifest.requestMessageId).toBe(reply.id);
    await model.send(c.id, {
      content: 'Late branch fact',
      mentions: [],
      threadId: thread.id,
      requestKey: randomUUID(),
    });
    expect((await model.detail(c.id)).runs[0].manifest.messages).toHaveLength(2);
  });

  it('retains directory and member exclusion after stop until physical confirmation', async () => {
    const { c, a, b } = await setup(true);
    await model.send(c.id, { content: 'First writer', mentions: [a.id], requestKey: randomUUID() });
    await model.send(c.id, {
      content: 'Second writer',
      mentions: [b.id],
      requestKey: randomUUID(),
    });
    const jobs = (await model.detail(c.id)).jobs;
    const first = await model.claim(c.id, jobs[0].id);
    expect(first).not.toBeNull();
    await model.stop(c.id, { runId: first!.run.id });
    expect(await model.claim(c.id, jobs[1].id)).toBeNull();
    await expect(model.saveDraft(c.id, first!.run.id, 1, 'Late result')).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    await model.releaseWriter(c.id, first!.run.id, 1);
    expect(await model.claim(c.id, jobs[1].id)).not.toBeNull();
    // Release this fixture's second writer so subsequent shared-directory tests are independent.
    const active = (await model.detail(c.id)).runs.find((r) => !r.writerReleased)!;
    await model.releaseWriter(c.id, active.id, 1);
  });

  it('recovers a saved final without rerunning and avoids feeding a member its own final twice', async () => {
    const { c, a } = await setup();
    await model.send(c.id, { content: 'First task', mentions: [a.id], requestKey: randomUUID() });
    const job = (await model.detail(c.id)).jobs[0];
    const first = await model.claim(c.id, job.id);
    await model.accepted(c.id, first!.run.id, 1, 'native-session', 'turn-1');
    await model.saveDraft(c.id, first!.run.id, 1, 'Saved final');
    // Fresh model instance represents the publisher after restart.
    const publisher = new ChannelModel(db, 'owner');
    const published = await publisher.publish(c.id, first!.run.id, 1);
    expect(await publisher.publish(c.id, first!.run.id, 1)).toBe(published);
    await model.releaseWriter(c.id, first!.run.id, 1);
    await model.send(c.id, { content: 'Next task', mentions: [a.id], requestKey: randomUUID() });
    const next = (await model.detail(c.id)).jobs.find((j) => j.status === 'queued')!;
    const second = await model.claim(c.id, next.id);
    expect(second!.run.manifest.messages.map((m) => m.content)).toEqual(['Next task']);
    expect(
      (await model.detail(c.id)).messages.filter((m) => m.content === 'Saved final'),
    ).toHaveLength(1);
  });

  it('rejects cross-channel references at both model and database boundaries', async () => {
    const x = await setup(),
      y = await setup();
    await expect(
      model.send(x.c.id, {
        content: 'Invalid target',
        mentions: [y.a.id],
        requestKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    const message = await model.send(x.c.id, {
      content: 'Owned',
      mentions: [],
      requestKey: randomUUID(),
    });
    await expect(
      db
        .insert(schema.channelJobs)
        .values({ id: randomUUID(), channelId: x.c.id, memberId: y.a.id, messageId: message.id }),
    ).rejects.toThrow();
  });

  it('keeps an unknown receipt recoverable and blocks a second writer until termination', async () => {
    const { c, a } = await setup();
    await model.send(c.id, { content: 'Work', mentions: [a.id], requestKey: randomUUID() });
    const { run } = (await model.claim(c.id, (await model.detail(c.id)).jobs[0].id))!;
    await model.executionUnknown(c.id, run.id, 1, 'Acknowledgement lost');
    let current = (await model.detail(c.id)).runs[0];
    expect(current.publicationRevoked).toBe(false);
    expect(current.writerReleased).toBe(false);
    await model.accepted(c.id, run.id, 1, 'recovered-session', 'recovered-turn');
    await model.saveDraft(c.id, run.id, 1, 'Recovered final');
    await model.releaseWriter(c.id, run.id, 1);
    await model.publish(c.id, run.id, 1);
    current = (await model.detail(c.id)).runs[0];
    expect(current.publishedMessageId).toBeTruthy();
    expect(current.status).toBe('completed');
  });

  it('retains one immutable approval decision and rejects late approval after stop', async () => {
    const { c, a } = await setup();
    await model.send(c.id, { content: 'Approval', mentions: [a.id], requestKey: randomUUID() });
    const { run } = (await model.claim(c.id, (await model.detail(c.id)).jobs[0].id))!;
    const approvalId = randomUUID();
    const expiresAt = new Date(Date.now() + 60000);
    await model.requestApproval(c.id, run.id, 1, approvalId, { command: 'write file' }, expiresAt);
    await model.decideApproval(c.id, approvalId, true);
    await model.decideApproval(c.id, approvalId, true);
    await expect(model.decideApproval(c.id, approvalId, false)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect((await model.detail(c.id)).approvals).toHaveLength(1);
    await model.stop(c.id, { runId: run.id });
    await expect(model.decideApproval(c.id, approvalId, true)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });
});

describe('Channel member lifecycle', () => {
  it('removal revokes unpublished drafts atomically and retains the old writer exclusion', async () => {
    const { c, a, b } = await setup();
    await model.send(c.id, { content: 'First', mentions: [a.id, b.id], requestKey: randomUUID() });
    const jobs = (await model.detail(c.id)).jobs;
    const claim = await model.claim(c.id, jobs.find((job) => job.memberId === a.id)!.id);
    await model.accepted(c.id, claim!.run.id, 1, 'session', 'turn');
    await model.saveDraft(c.id, claim!.run.id, 1, 'Late final');
    await model.retire(c.id, a.id);
    await expect(model.publish(c.id, claim!.run.id, 1)).rejects.toMatchObject({ code: 'CONFLICT' });
    const detail = await model.detail(c.id);
    expect(detail.runs[0]).toMatchObject({ publicationRevoked: true, writerReleased: false });
    expect(detail.jobs.find((job) => job.memberId === b.id)?.status).toBe('queued');
    expect(await model.claim(c.id, jobs.find((job) => job.memberId === b.id)!.id)).not.toBeNull();
    await model.releaseWriter(c.id, claim!.run.id, 1);
  });
  it('archival cancels routing and jobs but permits physical-stop acknowledgement', async () => {
    const { c, a } = await setup();
    await model.send(c.id, { content: 'Running', mentions: [a.id], requestKey: randomUUID() });
    const claim = await model.claim(c.id, (await model.detail(c.id)).jobs[0].id);
    await model.send(c.id, { content: 'Pending router', mentions: [], requestKey: randomUUID() });
    await model.retire(c.id);
    await expect(
      model.send(c.id, { content: 'After archive', mentions: [a.id], requestKey: randomUUID() }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await model.stop(c.id, { runId: claim!.run.id });
    await model.releaseWriter(c.id, claim!.run.id, 1);
    const detail = await model.detail(c.id);
    expect(detail.channel.archived).toBe(true);
    expect(detail.jobs.every((job) => job.status === 'cancelled')).toBe(true);
    expect(detail.runs[0].writerReleased).toBe(true);
  });
  it('session rebuild advances generation without copying private state or old cursors', async () => {
    const { c, a } = await setup();
    await model.send(c.id, {
      content: 'Original public context',
      mentions: [a.id],
      requestKey: randomUUID(),
    });
    const first = await model.claim(c.id, (await model.detail(c.id)).jobs[0].id);
    await expect(model.resetSession(c.id, a.id, null)).rejects.toMatchObject({ code: 'CONFLICT' });
    await model.accepted(c.id, first!.run.id, 1, 'lost-session', 'turn');
    await model.saveDraft(c.id, first!.run.id, 1, 'Public reply');
    await model.publish(c.id, first!.run.id, 1);
    await model.releaseWriter(c.id, first!.run.id, 1);
    await model.resetSession(c.id, a.id, null);
    await model.send(c.id, { content: 'Continue', mentions: [a.id], requestKey: randomUUID() });
    const next = await model.claim(
      c.id,
      (await model.detail(c.id)).jobs.find((job) => job.status === 'queued')!.id,
    );
    expect(next!.run.manifest.source).toBe('reconstructed');
    expect(next!.run.manifest.sessionGeneration).toBe(first!.run.manifest.sessionGeneration + 1);
    expect(next!.run.manifest.messages.map((message) => message.content)).toEqual([
      'Original public context',
      'Public reply',
      'Continue',
    ]);
  });
});

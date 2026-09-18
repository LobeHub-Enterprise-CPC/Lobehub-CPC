// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import * as schema from '../privateSchemas/channel';
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
    // Migration ownership moved to the enterprise chain (see
    // src/privateSchemas/channel.ts) after this test was written.
    readFileSync(
      new URL(
        '../../../../../packages/enterprise/src/database/migrations/0009_channel_mvp.sql',
        import.meta.url,
      ),
      'utf8',
    ).replaceAll('--> statement-breakpoint', ''),
  );
  await client.exec(
    readFileSync(
      new URL(
        '../../../../../packages/enterprise/src/database/migrations/0010_channel_attachments.sql',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  await client.exec(`
    CREATE TABLE files (id text PRIMARY KEY, user_id text, workspace_id text);
    INSERT INTO files VALUES ('doc', 'owner', NULL), ('image', 'owner', NULL),
      ('foreign', 'other', NULL), ('workspace-file', 'owner', 'workspace');
  `);
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
  it('persists attachment-only messages, preserves order in manifests and fences changed retries', async () => {
    const { c } = await setup();
    const input = {
      content: '',
      fileIds: ['image', 'doc', 'image'],
      mentions: [],
      requestKey: randomUUID(),
    };
    const message = await model.send(c.id, input);
    expect(message.fileIds).toEqual(['image', 'doc']);
    expect((await model.send(c.id, input)).id).toBe(message.id);
    await expect(model.send(c.id, { ...input, fileIds: ['doc', 'image'] })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    const detail = await model.page(c.id);
    expect(detail.messages.find((m) => m.id === message.id)?.fileIds).toEqual(['image', 'doc']);
    const { run } = (await model.claim(c.id, detail.jobs[0].id))!;
    expect(run.manifest.messages.find((m) => m.id === message.id)?.fileIds).toEqual([
      'image',
      'doc',
    ]);
  });

  it.each(['foreign', 'workspace-file', 'missing'])(
    'rejects inaccessible attachment %s without publishing',
    async (fileId) => {
      const { c } = await setup();
      await expect(
        model.send(c.id, {
          content: 'Read this',
          fileIds: ['doc', fileId],
          mentions: [],
          requestKey: randomUUID(),
        }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect((await model.detail(c.id)).messages).toEqual([]);
    },
  );

  it.each([0, 1, 7])('rejects creating a Channel with %i members', async (count) => {
    const before = await model.list();
    await expect(
      model.create(
        'Invalid count',
        Array.from({ length: count }, (_, i) => ({ name: `Agent ${i}`, config })),
      ),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(await model.list()).toHaveLength(before.length);
  });

  it.each([2, 6])('creates and broadcasts to all %i members', async (count) => {
    const channel = await model.create(
      'Member boundaries',
      Array.from({ length: count }, (_, i) => ({ name: `Agent ${i}`, config })),
    );
    await model.send(channel.id, { content: 'Everyone', mentions: [], requestKey: randomUUID() });
    const detail = await model.detail(channel.id);
    expect(detail.members).toHaveLength(count);
    expect(detail.jobs.map((job) => job.memberId).sort()).toEqual(
      detail.members.map((member) => member.id).sort(),
    );
  });

  it('allows adding one member up to six active members and reuses a removed slot', async () => {
    const channel = await model.create(
      'Capacity',
      Array.from({ length: 5 }, (_, i) => ({ name: `Agent ${i}`, config })),
    );
    const [sixth] = await model.addMembers(channel.id, [{ name: 'Sixth', config }]);
    await expect(model.addMembers(channel.id, [{ name: 'Seventh', config }])).rejects.toMatchObject(
      {
        code: 'BAD_REQUEST',
      },
    );
    expect((await model.detail(channel.id)).members).toHaveLength(6);
    await model.retire(channel.id, sixth.id);
    await model.addMembers(channel.id, [{ name: 'Replacement', config }]);
    const detail = await model.detail(channel.id);
    expect(detail.members).toHaveLength(7);
    expect(detail.members.filter((member) => member.active)).toHaveLength(6);
  });

  it('rejects duplicate Agents while preserving each member’s device and workspace', async () => {
    const member = { name: 'A', config: { ...config, agentId: 'same' } };
    await expect(model.create('Invalid', [member, member])).rejects.toThrow('already a member');
    const independent = [
      {
        name: 'A',
        config: { ...config, agentId: 'a', deviceId: 'device-a', workingDirectory: '/alpha' },
      },
      {
        name: 'B',
        config: { ...config, agentId: 'b', deviceId: 'device-b', workingDirectory: '/beta' },
      },
      {
        name: 'C',
        config: { ...config, agentId: 'c', deviceId: 'device-a', workingDirectory: '/gamma' },
      },
    ];
    const channel = await model.create('Independent Agents', independent.slice(0, 2));
    await model.addMembers(channel.id, [independent[2]]);
    expect((await model.detail(channel.id)).members).toEqual(
      expect.arrayContaining(independent.map((m) => expect.objectContaining(m))),
    );
    await expect(model.addMembers(channel.id, [independent[0]])).rejects.toThrow(
      'already a member',
    );
  });

  it.each(['stop', 'retire'] as const)(
    '%s preserves a released failure and its diagnostic',
    async (action) => {
      const { c, a } = await setup();
      await model.send(c.id, { content: 'Fail', mentions: [a.id], requestKey: randomUUID() });
      const { run } = (await model.claim(c.id, (await model.detail(c.id)).jobs[0].id))!;
      await model.fail(c.id, run.id, 1, 'Provider rejected request');
      await model.releaseWriter(c.id, run.id, 1);
      if (action === 'stop') await model.stop(c.id, { runId: run.id });
      else await model.retire(c.id, a.id);
      expect((await model.detail(c.id)).runs[0]).toMatchObject({
        status: 'failed',
        error: 'Provider rejected request',
        writerReleased: true,
      });
    },
  );

  it('atomically releases only definitely unsubmitted failures and allows the next delivery after restart', async () => {
    const { c, a } = await setup();
    await model.send(c.id, { content: 'First', mentions: [a.id], requestKey: randomUUID() });
    const first = (await model.claim(c.id, (await model.detail(c.id)).jobs[0].id))!;
    await model.fail(c.id, first.run.id, 1, 'preflight failure', false, true);
    const restarted = new ChannelModel(db, 'owner');
    expect((await restarted.detail(c.id)).runs[0]).toMatchObject({
      status: 'failed',
      writerReleased: true,
      publicationRevoked: true,
    });
    await expect(restarted.saveDraft(c.id, first.run.id, 1, 'late')).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    await restarted.send(c.id, { content: 'Second', mentions: [a.id], requestKey: randomUUID() });
    const job = (await restarted.detail(c.id)).jobs.find((j) => j.status === 'queued')!;
    const next = (await restarted.claim(c.id, job.id))!;
    expect(next.run.manifest.source).toBe('reconstructed');
    await restarted.fail(c.id, next.run.id, 1, 'ambiguous', true);
    expect((await restarted.detail(c.id)).runs.find((r) => r.id === next.run.id)).toMatchObject({
      writerReleased: false,
      status: 'execution_unknown',
    });
  });

  it('stop is idempotent while waiting for physical termination', async () => {
    const { c, a } = await setup();
    await model.send(c.id, { content: 'Stop', mentions: [a.id], requestKey: randomUUID() });
    const { run } = (await model.claim(c.id, (await model.detail(c.id)).jobs[0].id))!;
    await model.stop(c.id, { runId: run.id });
    const before = await db
      .select()
      .from(schema.channelAudit)
      .where(eq(schema.channelAudit.channelId, c.id));
    await model.stop(c.id, { runId: run.id });
    expect(
      await db.select().from(schema.channelAudit).where(eq(schema.channelAudit.channelId, c.id)),
    ).toHaveLength(before.length);
    expect((await model.detail(c.id)).runs[0]).toMatchObject({
      status: 'stop_requested',
      writerReleased: false,
    });
  });

  it('preserves cancellation when a stopped native runtime reports failure before release', async () => {
    const { c, a } = await setup();
    await model.send(c.id, { content: 'Stop', mentions: [a.id], requestKey: randomUUID() });
    const detail = await model.detail(c.id);
    const { run } = (await model.claim(c.id, detail.jobs[0].id))!;
    await model.stop(c.id, { runId: run.id });
    await model.fail(c.id, run.id, 1, 'Process exited after SIGTERM');
    await model.releaseWriter(c.id, run.id, 1);

    const stopped = await model.detail(c.id);
    expect(stopped.jobs[0].status).toBe('cancelled');
    expect(stopped.runs[0]).toMatchObject({
      error: null,
      physicalStopped: true,
      status: 'stopped',
      writerReleased: true,
    });
  });

  it('revokes an already released unpublished draft without leaving stop_requested', async () => {
    const { c, a } = await setup();
    await model.send(c.id, { content: 'Draft', mentions: [a.id], requestKey: randomUUID() });
    const { run } = (await model.claim(c.id, (await model.detail(c.id)).jobs[0].id))!;
    await model.saveDraft(c.id, run.id, 1, 'Unpublished');
    await model.releaseWriter(c.id, run.id, 1);
    await model.stop(c.id, { runId: run.id });
    expect((await model.detail(c.id)).runs[0]).toMatchObject({
      status: 'stopped',
      writerReleased: true,
    });
    await expect(model.publish(c.id, run.id, 1)).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('fences a recovered draft against the previous publisher', async () => {
    const { c, a } = await setup();
    await model.send(c.id, { content: 'Draft', mentions: [a.id], requestKey: randomUUID() });
    const { run } = (await model.claim(c.id, (await model.detail(c.id)).jobs[0].id))!;
    await model.accepted(c.id, run.id, 1, 'saved-session', 'saved-turn');
    await model.saveDraft(c.id, run.id, 1, 'Saved');
    await model.releaseWriter(c.id, run.id, 1);
    const fence = await model.recoverDraft(c.id, run.id, 1);
    expect(fence).toBe(2);
    await expect(model.publish(c.id, run.id, 1)).rejects.toMatchObject({ code: 'CONFLICT' });
    await model.publish(c.id, run.id, fence);
    expect((await model.detail(c.id)).messages.filter((m) => m.authorMemberId)).toHaveLength(1);
  });

  it('keeps one membership per existing Agent and permits rejoining after removal', async () => {
    const original = { name: 'Existing Agent', config: { ...config, agentId: 'owned-agent' } };
    const channel = await model.create('References', [original, members[1]]);
    await expect(model.addMembers(channel.id, [original])).rejects.toThrow('already a member');
    const first = (await model.detail(channel.id)).members.find(
      (member) => member.config.agentId === 'owned-agent',
    )!;
    await model.retire(channel.id, first.id);
    await model.addMembers(channel.id, [original]);
    expect((await model.detail(channel.id)).members.filter((m) => m.active)).toHaveLength(2);
  });

  it('renames a Channel for its owner alone and refuses to leave it unnamed or archived', async () => {
    const channel = await model.create('Reveiw', members);
    const renamed = await model.rename(channel.id, '  Review  ');
    expect(renamed.title).toBe('Review');
    // The navigation revision carries the title, so an open Channel sees the new name.
    const before = await model.revision(channel.id);
    expect((await model.rename(channel.id, 'Design review')).title).toBe('Design review');
    expect((await model.revision(channel.id)).navigationRevision).not.toBe(
      before.navigationRevision,
    );

    await expect(model.rename(channel.id, '   ')).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      new ChannelModel(db, 'other').rename(channel.id, 'Taken over'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await model.detail(channel.id)).channel.title).toBe('Design review');

    await model.retire(channel.id);
    await expect(model.rename(channel.id, 'Too late')).rejects.toMatchObject({ code: 'CONFLICT' });
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

  it('includes peers published before claim while retaining the original request identity', async () => {
    const { c, a, b } = await setup();
    const request = await model.send(c.id, {
      content: 'Everyone reply',
      mode: 'discussion',
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
    expect(second.run.manifest.cutoffSequence).toBe(request.sequence + 1);
    expect(second.run.manifest.requestMessageId).toBe(request.id);
    expect(second.run.manifest.messages.map((message) => message.content)).toEqual([
      'Everyone reply',
      'First response',
    ]);
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

  it('keeps thread replies with the root author and persists only explicitly invited followers', async () => {
    const { c, a, b } = await setup();
    const [outsider] = await model.addMembers(c.id, [{ name: 'Not invited', config }]);
    await model.send(c.id, {
      content: 'A reply please',
      mentions: [a.id],
      requestKey: randomUUID(),
    });
    const mainJob = (await model.detail(c.id)).jobs[0];
    const claim = (await model.claim(c.id, mainJob.id))!;
    await model.accepted(c.id, claim.run.id, 1, 'root-session', 'root-turn');
    await model.saveDraft(c.id, claim.run.id, 1, 'I am A');
    const rootId = await model.publish(c.id, claim.run.id, 1);
    if (!rootId) throw new Error('Fresh root reply was unexpectedly held');
    await model.releaseWriter(c.id, claim.run.id, 1);
    const thread = await model.branch(c.id, rootId);
    expect(thread.followerMemberIds).toEqual([a.id]);
    const send = (mentions: string[] = []) =>
      model.send(c.id, {
        content: 'Continue',
        mentions,
        threadId: thread.id,
        requestKey: randomUUID(),
      });
    const first = await send();
    const invitation = {
      content: 'Invite B',
      mentions: [b.id, b.id],
      threadId: thread.id,
      requestKey: randomUUID(),
    };
    const directed = await model.send(c.id, invitation);
    await model.send(c.id, invitation);
    const next = await send();
    let detail = await new ChannelModel(db, 'owner').detail(c.id);
    const recipients = (messageId: string) =>
      detail.jobs
        .filter((job) => job.messageId === messageId)
        .map((job) => job.memberId)
        .sort();
    expect(recipients(first.id)).toEqual([a.id]);
    expect(recipients(directed.id)).toEqual([b.id]);
    expect(recipients(next.id)).toEqual([a.id, b.id].sort());
    expect(detail.threads[0].followerMemberIds.sort()).toEqual([a.id, b.id].sort());
    expect(
      detail.jobs.some((job) => job.threadId === thread.id && job.memberId === outsider.id),
    ).toBe(false);

    await model.removeThreadFollower(c.id, thread.id, b.id);
    await model.removeThreadFollower(c.id, thread.id, b.id);
    await model.send(c.id, invitation); // A network retry must not re-invite a removed follower.
    const afterRemoval = await send();
    detail = await model.detail(c.id);
    expect(recipients(afterRemoval.id)).toEqual([a.id]);
    expect((await model.branch(c.id, rootId)).followerMemberIds).toEqual([a.id]);
    await send([b.id]); // A new mention can deliberately invite B again.
    expect((await model.detail(c.id)).threads[0].followerMemberIds.sort()).toEqual(
      [a.id, b.id].sort(),
    );
    await model.retire(c.id, b.id);
    const afterRetirement = await send();
    detail = await model.detail(c.id);
    expect(recipients(afterRetirement.id)).toEqual([a.id]);
  });

  it('removes a follower only from this thread, fences its pending reply and never falls back to everyone', async () => {
    const { c, a, b } = await setup();
    const root = await model.send(c.id, {
      content: 'For A',
      mentions: [a.id],
      requestKey: randomUUID(),
    });
    const thread = await model.branch(c.id, root.id);
    const otherRoot = await model.send(c.id, {
      content: 'Another for A',
      mentions: [a.id],
      requestKey: randomUUID(),
    });
    const sibling = await model.branch(c.id, otherRoot.id);
    await model.stop(c.id, { threadId: null });
    const reply = await model.send(c.id, {
      content: 'Thread request',
      mentions: [],
      threadId: thread.id,
      requestKey: randomUUID(),
    });
    const job = (await model.detail(c.id)).jobs.find((job) => job.messageId === reply.id)!;
    const claim = (await model.claim(c.id, job.id))!;
    await model.saveDraft(c.id, claim.run.id, 1, 'Must not publish');
    const main = await model.send(c.id, {
      content: 'Main stays active',
      mentions: [],
      requestKey: randomUUID(),
    });
    await expect(
      new ChannelModel(db, 'other').removeThreadFollower(c.id, thread.id, a.id),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const otherChannel = await setup();
    await expect(
      model.removeThreadFollower(otherChannel.c.id, thread.id, a.id),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      model.send(c.id, {
        content: 'Invalid invite',
        mentions: [otherChannel.a.id],
        threadId: thread.id,
        requestKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await model.removeThreadFollower(c.id, thread.id, a.id);
    await expect(model.publish(c.id, claim.run.id, 1)).rejects.toThrow();
    const empty = await model.send(c.id, {
      content: 'Nobody invited',
      mentions: [],
      threadId: thread.id,
      requestKey: randomUUID(),
    });
    expect(empty.routingStatus).toBe('unassigned');
    await model.retryRouting(c.id, empty.id);
    expect((await model.routingInput(c.id, empty.id))?.members).toEqual([]);
    await model.assign(c.id, empty.id, { memberIds: [a.id, b.id], reason: 'Stale routing' });
    const detail = await model.detail(c.id);
    expect(detail.jobs.filter((job) => job.messageId === empty.id)).toEqual([]);
    expect(detail.jobs.find((item) => item.id === job.id)?.status).toBe('cancelled');
    expect(
      detail.jobs
        .filter((job) => job.messageId === main.id)
        .every((job) => job.status === 'queued'),
    ).toBe(true);
    expect(detail.threads.find((item) => item.id === sibling.id)?.followerMemberIds).toEqual([
      a.id,
    ]);
    expect(detail.members.every((member) => member.active)).toBe(true);
    expect(detail.runs.find((run) => run.id === claim.run.id)).toMatchObject({
      publicationRevoked: true,
      writerReleased: false,
    });
  });

  it('starts an unmentioned human root with no followers', async () => {
    const { c } = await setup();
    const root = await model.send(c.id, {
      content: 'Main broadcast',
      mentions: [],
      requestKey: randomUUID(),
    });
    expect((await model.branch(c.id, root.id)).followerMemberIds).toEqual([]);
  });

  it('forks the authorized public prefix and reuses roots without replaying future history', async () => {
    const { c, a } = await setup();
    const root = await model.send(c.id, {
      content: 'Root context',
      fileIds: ['doc'],
      mentions: [],
      requestKey: randomUUID(),
    });
    await model.send(c.id, {
      content: 'Future main secret',
      fileIds: ['image'],
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
    expect(claim?.run.manifest.messages.flatMap((m) => m.fileIds ?? [])).toEqual(['doc']);
    expect(claim?.run.manifest.requestMessageId).toBe(reply.id);
    await model.send(c.id, {
      content: 'Late branch fact',
      mentions: [],
      threadId: thread.id,
      requestKey: randomUUID(),
    });
    expect((await model.detail(c.id)).runs[0].manifest.messages).toHaveLength(2);
  });

  it('keeps member identity across a branch and delta without conflating same-name members', async () => {
    const c = await model.create('Identity', [
      { name: 'Reviewer', config },
      { name: 'Reviewer', config },
      { name: 'Late reviewer', config },
    ]);
    const [self, other, late] = (await model.detail(c.id)).members;
    await model.send(c.id, { content: 'Where are you?', mentions: [], requestKey: randomUUID() });
    const jobs = (await model.detail(c.id)).jobs;
    const mainSessions = new Map<string, string>();
    for (const [member, answer] of [
      [other, 'Other reply'],
      [self, 'My reply'],
      [late, 'Late reply'],
    ] as const) {
      const { run, session } = (await model.claim(
        c.id,
        jobs.find((job) => job.memberId === member.id)!.id,
      ))!;
      expect(run.manifest.self).toEqual({ memberId: member.id, name: member.name });
      expect(run.manifest.threadRootSequence).toBeNull();
      mainSessions.set(member.id, session.id);
      await model.accepted(c.id, run.id, 1, `main-${member.id}`, 'turn');
      await model.saveDraft(c.id, run.id, 1, answer);
      await model.publish(c.id, run.id, 1);
      await model.releaseWriter(c.id, run.id, 1);
    }
    await model.stop(c.id, { threadId: null });
    const root = (await model.detail(c.id)).messages.find((m) => m.content === 'My reply')!;
    const thread = await model.branch(c.id, root.id);
    const request = await model.send(c.id, {
      content: 'Who else replied?',
      mentions: [self.id],
      requestKey: randomUUID(),
      threadId: thread.id,
    });
    const first = (await model.claim(
      c.id,
      (await model.detail(c.id)).jobs.find((job) => job.messageId === request.id)!.id,
    ))!;
    expect(first.session.id).not.toBe(mainSessions.get(self.id));
    expect(first.run.manifest).toMatchObject({
      self: { memberId: self.id, name: 'Reviewer' },
      threadId: thread.id,
      threadRootSequence: 3,
      cutoffSequence: 5,
      source: 'reconstructed',
    });
    expect(first.run.manifest.messages.map((m) => [m.content, m.author.id])).toEqual([
      ['Where are you?', 'owner'],
      ['Other reply', other.id],
      ['My reply', self.id],
      ['Who else replied?', 'owner'],
    ]);
    await model.accepted(c.id, first.run.id, 1, 'branch-session', 'turn');
    await model.saveDraft(c.id, first.run.id, 1, 'One other visible member');
    await model.publish(c.id, first.run.id, 1);
    await model.releaseWriter(c.id, first.run.id, 1);
    const followup = await model.send(c.id, {
      content: 'And now?',
      mentions: [self.id],
      requestKey: randomUUID(),
      threadId: thread.id,
    });
    const next = (await model.claim(
      c.id,
      (await model.detail(c.id)).jobs.find((job) => job.messageId === followup.id)!.id,
    ))!;
    expect(next.run.manifest).toMatchObject({
      self: { memberId: self.id, name: 'Reviewer' },
      threadRootSequence: 3,
      cutoffSequence: 7,
      source: 'incremental',
    });
    expect(next.session.nativeSessionId).toBe('branch-session');
    expect(next.run.manifest.messages.map((m) => m.content)).toEqual([
      'One other visible member',
      'And now?',
    ]);
  });

  it('does not serialize independent members sharing a directory, but revokes stopped replies', async () => {
    const { c, a, b } = await setup(true);
    await model.send(c.id, {
      content: 'Both writers',
      mentions: [a.id, b.id],
      requestKey: randomUUID(),
    });
    const jobs = (await model.detail(c.id)).jobs;
    const first = await model.claim(c.id, jobs[0].id);
    expect(first).not.toBeNull();
    const second = await model.claim(c.id, jobs[1].id);
    expect(second).not.toBeNull();
    await model.stop(c.id, { runId: first!.run.id });
    await expect(model.saveDraft(c.id, first!.run.id, 1, 'Late result')).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    await model.releaseWriter(c.id, first!.run.id, 1);
    await model.releaseWriter(c.id, second!.run.id, 1);
  });

  it('recovers a saved final and delivers its publication receipt to the author exactly once', async () => {
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
    expect(second!.run.manifest.messages.map((m) => m.content)).toEqual([
      'Saved final',
      'Next task',
    ]);
    expect(second!.run.manifest.messages[0]).toMatchObject({
      id: published,
      author: { id: a.id, type: 'member' },
    });
    await model.accepted(c.id, second!.run.id, 1, 'native-session', 'turn-2');
    await model.saveDraft(c.id, second!.run.id, 1, 'Second answer');
    const secondPublished = await model.publish(c.id, second!.run.id, 1);
    await model.releaseWriter(c.id, second!.run.id, 1);
    const thirdRequest = await model.send(c.id, {
      content: 'Third task',
      mentions: [a.id],
      requestKey: randomUUID(),
    });
    const thirdJob = (await model.detail(c.id)).jobs.find((j) => j.messageId === thirdRequest.id)!;
    const third = (await model.claim(c.id, thirdJob.id))!;
    expect(third.run.manifest.messages.map((m) => m.content)).toEqual([
      'Second answer',
      'Third task',
    ]);
    expect(third.run.manifest.messages[0].id).toBe(secondPublished);
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

  it('polls pending approvals without a write transaction and expires them atomically', async () => {
    const { c, a } = await setup();
    await model.send(c.id, { content: 'Approve', mentions: [a.id], requestKey: randomUUID() });
    const { run } = (await model.claim(c.id, (await model.detail(c.id)).jobs[0].id))!;
    const approvalId = randomUUID();
    const deadline = new Date(Date.now() + 60000);
    await model.requestApproval(c.id, run.id, 1, approvalId, {}, deadline);
    const transaction = vi.spyOn(db, 'transaction');
    await model.requestApproval(c.id, run.id, 1, approvalId, {}, deadline);
    expect(transaction).not.toHaveBeenCalled();
    transaction.mockRestore();
    await db
      .update(schema.channelApprovals)
      .set({ expiresAt: new Date(0) })
      .where(eq(schema.channelApprovals.id, approvalId));
    const expired = await model.requestApproval(c.id, run.id, 1, approvalId, {}, deadline);
    expect(expired.decision).toBe('expired');
    expect((await model.detail(c.id)).runs[0]).toMatchObject({
      status: 'stop_requested',
      publicationRevoked: true,
      writerReleased: false,
    });
    await expect(model.decideApproval(c.id, approvalId, true)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
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
  it('soft deletion hides the Channel and old thread links without losing stop receipts', async () => {
    const { c, a } = await setup();
    const other = await setup();
    const message = await model.send(c.id, {
      content: 'Running',
      mentions: [a.id],
      requestKey: randomUUID(),
    });
    const thread = await model.branch(c.id, message.id);
    const claim = await model.claim(c.id, (await model.detail(c.id)).jobs[0].id);
    await expect(new ChannelModel(db, 'other').retire(c.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await model.retire(c.id);
    await model.retire(c.id);
    expect((await model.listWithThreads()).map((channel) => channel.id)).not.toContain(c.id);
    expect((await model.list()).map((channel) => channel.id)).toContain(other.c.id);
    await expect(model.page(c.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(model.page(c.id, { threadId: thread.id })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(model.revision(c.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const detail = await model.detail(c.id);
    expect(detail.runs[0]).toMatchObject({ publicationRevoked: true, writerReleased: false });
    await model.stop(c.id, { runId: claim!.run.id });
    await model.releaseWriter(c.id, claim!.run.id, 1);
    expect((await model.detail(c.id)).runs[0].writerReleased).toBe(true);
  });

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
    expect(next!.run.manifest.self).toEqual({ memberId: a.id, name: a.name });
    expect(first!.run.manifest.self).toEqual({ memberId: a.id, name: a.name });
    expect(next!.run.manifest.messages.find((m) => m.content === 'Public reply')?.author).toEqual({
      id: a.id,
      name: a.name,
      type: 'member',
    });
    expect(next!.run.manifest.messages.map((message) => message.content)).toEqual([
      'Original public context',
      'Public reply',
      'Continue',
    ]);
  });
});

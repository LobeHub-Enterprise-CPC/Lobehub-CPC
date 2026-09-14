// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { CHANNEL_HISTORY } from '@lobechat/types';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { getTestDB } from '../../core/getTestDB';
import { channelJobs, channelMessages, channelRuns, channels, users } from '../../schemas';
import type { LobeChatDatabase } from '../../type';
import { ChannelModel } from '../channel';

let db: LobeChatDatabase;
const ownerId = `channel-read-${randomUUID()}`;
const otherId = `channel-read-${randomUUID()}`;
let model: ChannelModel;
const config = { model: 'test', provider: 'test', runtime: 'native' as const };

beforeAll(async () => {
  db = await getTestDB();
  await db.insert(users).values([{ id: ownerId }, { id: otherId }]);
  model = new ChannelModel(db, ownerId);
}, 60000);
afterAll(async () => {
  if (db) {
    await db.delete(users).where(eq(users.id, ownerId));
    await db.delete(users).where(eq(users.id, otherId));
  }
});

const create = () =>
  model.create('Read fixture', [
    { name: 'A', config },
    { name: 'B', config },
  ]);

async function messages(channelId: string, amount: number, threadId: string | null = null) {
  const [channel] = await db.select().from(channels).where(eq(channels.id, channelId));
  const values = Array.from({ length: amount }, (_, i) => {
    const sequence = channel.sequence + i + 1;
    return {
      channelId,
      threadId,
      sequence,
      id: `${channelId}-message-${sequence}`,
      content: `Message ${sequence}\n${'historical text '.repeat(100)}`,
      requestKey: randomUUID(),
      routingStatus: 'assigned' as const,
    };
  });
  await db.insert(channelMessages).values(values);
  await db
    .update(channels)
    .set({ sequence: channel.sequence + amount })
    .where(eq(channels.id, channelId));
  return values;
}

describe('Channel bounded presentation reads', () => {
  it('pages a scope without gaps or duplicates while newer messages arrive', async () => {
    const channel = await create();
    const seeded = await messages(channel.id, 130);
    const thread = await model.branch(channel.id, seeded[0].id);
    const replies = await messages(channel.id, 7, thread.id);
    const first = await model.page(channel.id);
    expect(first.messages).toHaveLength(CHANNEL_HISTORY.pageSize);
    expect(first.messages.map((message) => message.sequence)).toEqual(
      seeded.slice(80).map((message) => message.sequence),
    );
    await messages(channel.id, 4);
    const second = await model.page(channel.id, { before: first.nextCursor! });
    const third = await model.page(channel.id, { before: second.nextCursor! });
    expect(
      [...third.messages, ...second.messages, ...first.messages].map((message) => message.id),
    ).toEqual(seeded.map((message) => message.id));
    expect(third.nextCursor).toBeNull();
    const branch = await model.page(channel.id, { threadId: thread.id });
    expect(branch.messages.map((message) => message.id)).toEqual(
      replies.map((message) => message.id),
    );
    expect(branch.contextMessages.map((message) => message.id)).toContain(seeded[0].id);
    expect(branch.replyCounts).toEqual([{ threadId: thread.id, count: 7 }]);
  });

  it('returns the same size message window after history grows and omits history from revision polling', async () => {
    const channel = await create();
    await messages(channel.id, 100);
    const initial = await model.page(channel.id);
    await messages(channel.id, 1000);
    const page = await model.page(channel.id);
    expect(page.messages.length).toBe(initial.messages.length);
    expect(page.contextMessages).toHaveLength(0);
    expect(page.runs).toEqual([]);
    expect(JSON.stringify(page).length).toBeLessThan(
      JSON.stringify(await model.detail(channel.id)).length / 10,
    );
    const revision = await model.revision(channel.id);
    expect(JSON.stringify(revision).length).toBeLessThan(200);
    expect(JSON.stringify(revision)).not.toContain('historical text');
    expect(await model.revision(channel.id)).toEqual(revision);
  });

  it('keeps old active requests and approvals visible without returning the private manifest', async () => {
    const channel = await create();
    const member = (await model.page(channel.id)).members[0];
    const request = await model.send(channel.id, {
      content: 'An old active request',
      mentions: [member.id],
      requestKey: randomUUID(),
    });
    const [job] = await db.select().from(channelJobs).where(eq(channelJobs.messageId, request.id));
    const { run } = (await model.claim(channel.id, job.id))!;
    await db
      .update(channelRuns)
      .set({
        manifest: {
          ...run.manifest,
          messages: [{ ...run.manifest.messages[0], content: 'private-history'.repeat(10000) }],
        },
      })
      .where(eq(channelRuns.id, run.id));
    await messages(channel.id, 100);
    const before = await model.revision(channel.id);
    await model.setActivity(channel.id, run.id, run.fence, 'typing');
    const typing = await model.revision(channel.id);
    expect(typing.revision).not.toBe(before.revision);
    expect(typing.navigationRevision).toBe(before.navigationRevision);
    const approvalId = randomUUID();
    await model.requestApproval(
      channel.id,
      run.id,
      run.fence,
      approvalId,
      { command: 'test' },
      new Date(Date.now() + 60000),
    );
    expect((await model.revision(channel.id)).revision).not.toBe(typing.revision);
    const page = await model.page(channel.id);
    expect(page.messages).toHaveLength(CHANNEL_HISTORY.pageSize);
    expect(page.contextMessages.map((message) => message.id)).toContain(request.id);
    expect(page.jobs.some((item) => item.id === job.id)).toBe(true);
    expect(page.approvals.map((item) => item.id)).toContain(approvalId);
    expect(page.runs[0].manifest).toEqual({ threadId: null, requestMessageId: request.id });
    expect(JSON.stringify(page)).not.toContain('private-history');
    const awaiting = await model.revision(channel.id);
    await model.decideApproval(channel.id, approvalId, true);
    expect((await model.revision(channel.id)).revision).not.toBe(awaiting.revision);
    await model.fail(channel.id, run.id, run.fence, 'failed');
    await model.releaseWriter(channel.id, run.id, run.fence);
    const settled = await model.revision(channel.id);
    await db
      .update(channelRuns)
      .set({ manifest: { ...run.manifest, messages: [] } })
      .where(eq(channelRuns.id, run.id));
    expect(await model.revision(channel.id)).toEqual(settled);
    expect((await model.page(channel.id)).runs).toHaveLength(0);
    const historical = await model.page(channel.id, { before: 2 });
    expect(historical.runs[0]).toMatchObject({ id: run.id, status: 'failed' });
  });

  it('includes the latest failed request when browsing an older page', async () => {
    const channel = await create();
    await messages(channel.id, 70);
    const member = (await model.page(channel.id)).members[0];
    const request = await model.send(channel.id, {
      content: 'Latest request',
      mentions: [member.id],
      requestKey: randomUUID(),
    });
    const [job] = await db.select().from(channelJobs).where(eq(channelJobs.messageId, request.id));
    const { run } = (await model.claim(channel.id, job.id))!;
    await model.fail(channel.id, run.id, run.fence, 'Failed');
    await model.releaseWriter(channel.id, run.id, run.fence);
    const page = await model.page(channel.id, { before: 20 });
    expect(page.messages.at(-1)?.sequence).toBe(19);
    expect(page.contextMessages.some((message) => message.id === request.id)).toBe(true);
    expect(page.runs[0]).toMatchObject({ id: run.id, status: 'failed' });
  });

  it('loads thread navigation in bulk and scopes every read to its owner and Channel', async () => {
    const channel = await create();
    const seeded = await messages(channel.id, 2);
    const member = (await model.page(channel.id)).members[0];
    await db
      .update(channelMessages)
      .set({ mentions: [member.id] })
      .where(eq(channelMessages.id, seeded[0].id));
    const thread = await model.branch(channel.id, seeded[0].id);
    const other = new ChannelModel(db, otherId);
    const outsider = await other.create('Other', [
      { name: 'A', config },
      { name: 'B', config },
    ]);
    const rows = await model.listWithThreads();
    expect(rows.some((row) => row.id === outsider.id)).toBe(false);
    const navigation = rows.find((row) => row.id === channel.id)!;
    expect(navigation.threads[0]).toMatchObject({ id: thread.id, title: 'Message 1' });
    expect(JSON.stringify(navigation)).not.toContain('historical text');
    expect(navigation).not.toHaveProperty('messages');
    await expect(other.page(channel.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(other.revision(channel.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(other.page(outsider.id, { threadId: thread.id })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    const previous = await model.revision(channel.id);
    await model.removeThreadFollower(
      channel.id,
      thread.id,
      navigation.threads[0].followerMemberIds[0],
    );
    expect((await model.revision(channel.id)).revision).not.toBe(previous.revision);
  });

  it('replays the consolidated discussion migration without modifying messages', async () => {
    const channel = await create();
    await messages(channel.id, 3);
    const before = await model.page(channel.id);
    const migration = readFileSync(
      new URL('../../../migrations/0162_channel_discussions.sql', import.meta.url),
      'utf8',
    );
    for (const statement of migration.split('--> statement-breakpoint'))
      await db.execute(sql.raw(statement));
    expect(await model.page(channel.id)).toEqual(before);
  });
});

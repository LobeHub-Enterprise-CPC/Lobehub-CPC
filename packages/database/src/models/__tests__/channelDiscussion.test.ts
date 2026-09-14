// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import * as schema from '../../schemas/channel';
import type { LobeChatDatabase } from '../../type';
import { ChannelModel } from '../channel';

let client: PGlite;
let db: LobeChatDatabase;
let model: ChannelModel;
const config = { model: 'deepseek-v4-flash', provider: 'deepseek', runtime: 'native' as const };

beforeAll(async () => {
  client = new PGlite();
  await client.exec(
    "create table users (id text primary key); insert into users values ('owner'), ('other');",
  );
  for (const migration of ['0163_channel_mvp.sql']) {
    await client.exec(
      readFileSync(new URL(`../../../migrations/${migration}`, import.meta.url), 'utf8').replaceAll(
        '--> statement-breakpoint',
        '',
      ),
    );
  }
  db = drizzle(client, { schema }) as unknown as LobeChatDatabase;
  model = new ChannelModel(db, 'owner');
}, 30_000);

afterAll(async () => client?.close());

async function setup(ownerModel = model) {
  const channel = await ownerModel.create('Discussion regression', [
    { name: 'Alpha', config },
    { name: 'Beta', config },
  ]);
  const [a, b] = (await ownerModel.detail(channel.id)).members;
  return { channel, a, b };
}

async function acceptDraftRelease(
  channelId: string,
  runId: string,
  content: string,
  session = `session-${runId}`,
) {
  await model.accepted(channelId, runId, 1, session, `turn-${runId}`);
  await model.saveDraft(channelId, runId, 1, content);
  const messageId = await model.publish(channelId, runId, 1);
  await model.releaseWriter(channelId, runId, 1);
  return messageId;
}

describe('Channel free collaboration regressions', () => {
  it.each([undefined, 'normal'] as const)(
    'keeps %s messages on the original one-reply delivery path',
    async (mode) => {
      const { channel, a } = await setup();
      const request = await model.send(channel.id, {
        content: 'Hello',
        mentions: [],
        requestKey: randomUUID(),
        mode,
        maxDiscussionRounds: 5,
      });
      const jobs = (await model.detail(channel.id)).jobs;
      expect(jobs).toHaveLength(2);
      const runs = await Promise.all(
        jobs.map(async (job) => (await model.claim(channel.id, job.id))!.run),
      );
      for (const run of runs) {
        expect(run.manifest.discussion).toBeUndefined();
        expect(run.manifest.cutoffSequence).toBe(request.sequence);
        expect(await acceptDraftRelease(channel.id, run.id, `Hello from ${run.memberId}`)).toEqual(
          expect.any(String),
        );
      }
      await model.advanceDiscussions(channel.id);
      let detail = await model.detail(channel.id);
      expect(detail.discussions).toEqual([]);
      expect(detail.messages).toHaveLength(3);
      expect(detail.jobs).toHaveLength(2);
      expect(detail.jobs.every((job) => job.status === 'completed' && !job.discussionId)).toBe(
        true,
      );
      const directed = await model.send(channel.id, {
        content: 'Only you',
        mentions: [a.id],
        requestKey: randomUUID(),
        mode,
      });
      const directedJobs = (await model.detail(channel.id)).jobs.filter(
        (job) => job.messageId === directed.id,
      );
      expect(directedJobs.map((job) => job.memberId)).toEqual([a.id]);
      const directedRun = (await model.claim(channel.id, directedJobs[0].id))!;
      expect(directedRun.run.manifest.source).toBe('incremental');
      await acceptDraftRelease(
        channel.id,
        directedRun.run.id,
        'One normal reply',
        directedRun.session.nativeSessionId!,
      );
      await model.advanceDiscussions(channel.id);
      detail = await model.detail(channel.id);
      expect(detail.discussions).toEqual([]);
      expect(detail.jobs).toHaveLength(3);
      expect(detail.jobs.every((job) => job.status === 'completed')).toBe(true);
    },
  );

  it('requires explicit discussion mode and rejects changing mode or budget on a retry', async () => {
    const { channel } = await setup();
    const input = { content: 'Review', mentions: [], requestKey: randomUUID() };
    const normal = await model.send(channel.id, input);
    expect((await model.send(channel.id, { ...input, mode: 'normal' })).id).toBe(normal.id);
    await expect(model.send(channel.id, { ...input, mode: 'discussion' })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    const discussionInput = { ...input, mode: 'discussion' as const, requestKey: randomUUID() };
    const discussion = await model.send(channel.id, discussionInput);
    expect((await model.send(channel.id, discussionInput)).id).toBe(discussion.id);
    // No explicit budget: the default is a fixed number of rounds, each giving everyone one turn.
    expect((await model.detail(channel.id)).discussions).toMatchObject([
      { id: discussion.id, maxRounds: 3, round: 1 },
    ]);
    await expect(
      model.send(channel.id, { ...discussionInput, mode: 'normal' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(
      model.send(channel.id, { ...discussionInput, maxDiscussionRounds: 2 }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    for (const maxDiscussionRounds of [0, 11, 1.5])
      await expect(
        model.send(channel.id, {
          ...input,
          mode: 'discussion',
          requestKey: randomUUID(),
          maxDiscussionRounds,
        }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('atomically gates simultaneous distinct publications and rejects cross-owner mutation', async () => {
    const { channel } = await setup();
    await model.send(channel.id, {
      content: 'Concurrent proposals',
      mode: 'discussion',
      mentions: [],
      requestKey: randomUUID(),
    });
    const runs = await Promise.all(
      (await model.detail(channel.id)).jobs.map(async (job) => {
        const claim = (await model.claim(channel.id, job.id))!;
        await model.accepted(channel.id, claim.run.id, 1, `native-${job.memberId}`, 'turn');
        await model.saveDraft(channel.id, claim.run.id, 1, `proposal-${job.memberId}`);
        return claim.run;
      }),
    );
    await expect(
      new ChannelModel(db, 'other').publish(channel.id, runs[0].id, 1),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const publications = await Promise.all(runs.map((run) => model.publish(channel.id, run.id, 1)));
    expect(publications.filter(Boolean)).toHaveLength(1);
    expect(publications.filter((value) => value === null)).toHaveLength(1);
    const reconnected = new ChannelModel(db, 'owner');
    expect(
      await Promise.all(runs.map((run) => reconnected.publish(channel.id, run.id, 1))),
    ).toEqual(publications);
    expect((await model.detail(channel.id)).messages).toHaveLength(2);
  });

  it('publishes only one concurrent cutoff draft and holds the other for one same-session revision', async () => {
    const { channel, a, b } = await setup();
    const request = await model.send(channel.id, {
      content: 'Review together',
      mode: 'discussion',
      mentions: [],
      requestKey: randomUUID(),
      maxDiscussionRounds: 6,
    });
    const jobs = (await model.detail(channel.id)).jobs;
    expect(jobs.map((j) => j.task)).toEqual([
      { kind: 'discuss', round: 1 },
      { kind: 'discuss', round: 1 },
    ]);
    const alpha = (await model.claim(channel.id, jobs.find((j) => j.memberId === a.id)!.id))!;
    const beta = (await model.claim(channel.id, jobs.find((j) => j.memberId === b.id)!.id))!;
    expect(alpha.run.manifest.cutoffSequence).toBe(beta.run.manifest.cutoffSequence);

    await model.accepted(channel.id, alpha.run.id, 1, 'alpha-native', 'alpha-turn');
    await model.accepted(channel.id, beta.run.id, 1, 'beta-native', 'beta-turn');
    await model.saveDraft(channel.id, alpha.run.id, 1, 'Alpha proposal');
    await model.saveDraft(channel.id, beta.run.id, 1, 'Beta stale proposal');
    await model.publish(channel.id, alpha.run.id, 1);
    expect(await model.publish(channel.id, beta.run.id, 1)).toBeNull();
    expect(await model.publish(channel.id, beta.run.id, 1)).toBeNull();

    const detail = await model.detail(channel.id);
    expect(detail.messages.map((m) => m.content)).toEqual(['Review together', 'Alpha proposal']);
    // Only Alpha's reply was published; Beta's held attempt keeps its turn open in round 1.
    expect(detail.discussions[0]).toMatchObject({ round: 1, turnsPublished: 1 });
    // Publishing wakes nobody: Alpha gets no extra job until the round ends.
    expect(detail.jobs.filter((j) => j.memberId === a.id)).toHaveLength(1);
    expect(
      (await db.select().from(schema.channelRuns).where(eq(schema.channelRuns.id, beta.run.id)))[0]
        .publicationStatus,
    ).toBe('held');
    const revisions = detail.jobs.filter(
      (j) => j.memberId === b.id && j.status === 'queued' && j.task?.kind === 'revise',
    );
    expect(revisions).toHaveLength(1);
    expect(await model.claim(channel.id, revisions[0].id)).toBeNull();

    await model.releaseWriter(channel.id, beta.run.id, 1);
    const continuation = (await model.claim(channel.id, revisions[0].id))!;
    expect(continuation.session.nativeSessionId).toBe('beta-native');
    expect(continuation.run.manifest).toMatchObject({
      source: 'incremental',
      requestMessageId: request.id,
      discussion: { kind: 'revise', heldDraft: 'Beta stale proposal', round: 1, maxRounds: 6 },
    });
    expect(continuation.run.manifest.messages.map((m) => m.content)).toContain('Alpha proposal');
    expect(continuation.run.manifest.messages.some((m) => m.id === request.id)).toBe(false);
    expect(
      (await db.select().from(schema.channelRuns).where(eq(schema.channelRuns.id, beta.run.id)))[0]
        .draft,
    ).toBe('Beta stale proposal');
  });

  it('allows a fresh identical agreement rather than globally deduplicating text', async () => {
    const { channel, a, b } = await setup();
    await model.send(channel.id, {
      content: 'Can we agree?',
      mode: 'discussion',
      mentions: [],
      requestKey: randomUUID(),
      maxDiscussionRounds: 4,
    });
    let queued = (await model.detail(channel.id)).jobs.filter((j) => j.status === 'queued');
    const first = (await model.claim(channel.id, queued.find((j) => j.memberId === a.id)!.id))!;
    await acceptDraftRelease(channel.id, first.run.id, '同意');
    queued = (await model.detail(channel.id)).jobs.filter((j) => j.status === 'queued');
    const second = (await model.claim(channel.id, queued.find((j) => j.memberId === b.id)!.id))!;
    await acceptDraftRelease(channel.id, second.run.id, '同意');
    expect(
      (await model.detail(channel.id)).messages.filter((m) => m.content === '同意'),
    ).toHaveLength(2);
  });

  it('gives every participant one turn in a single round, then summarizes at the round limit', async () => {
    const { channel, a, b } = await setup();
    await model.send(channel.id, {
      content: 'One round only',
      mode: 'discussion',
      mentions: [],
      requestKey: randomUUID(),
      maxDiscussionRounds: 1,
    });
    const jobs = (await model.detail(channel.id)).jobs;
    // Turns within a round are concurrent: both members may draft at once.
    const first = (await model.claim(channel.id, jobs.find((j) => j.memberId === a.id)!.id))!.run;
    const late = (await model.claim(channel.id, jobs.find((j) => j.memberId === b.id)!.id))!.run;
    expect(first.manifest.discussion).toMatchObject({ kind: 'discuss', round: 1, maxRounds: 1 });
    expect(await acceptDraftRelease(channel.id, first.id, 'First answer')).toEqual(
      expect.any(String),
    );
    // The slower draft missed First answer, so it is held and revised, still inside round 1:
    // a round is not over until every participant has had its turn.
    expect(
      await acceptDraftRelease(channel.id, late.id, 'Unaware answer', 'beta-native'),
    ).toBeNull();
    await model.advanceDiscussions(channel.id);
    let detail = await model.detail(channel.id);
    expect(detail.discussions[0]).toMatchObject({ status: 'active', round: 1, turnsPublished: 1 });
    const revision = detail.jobs.find((j) => j.memberId === b.id && j.status === 'queued')!;
    expect(revision.task).toMatchObject({ kind: 'revise', round: 1 });
    const revised = (await model.claim(channel.id, revision.id))!.run;
    expect(
      await acceptDraftRelease(
        channel.id,
        revised.id,
        'Second answer, after reading',
        'beta-native',
      ),
    ).toEqual(expect.any(String));
    await model.advanceDiscussions(channel.id);
    detail = await model.detail(channel.id);
    // Both spoke once and the only round is spent: no round 2 opens, the limit summary follows.
    expect(detail.discussions[0]).toMatchObject({
      status: 'summarizing',
      endReason: 'limit',
      round: 1,
      turnsPublished: 2,
    });
    expect(detail.jobs.filter((j) => j.deliveryKey.startsWith('round:'))).toHaveLength(0);
    const summaries = detail.jobs.filter((j) => j.task?.kind === 'summarize');
    expect(summaries).toHaveLength(1);
    const summary = (await model.claim(channel.id, summaries[0].id))!.run;
    expect(summary.manifest.discussion).toMatchObject({
      kind: 'summarize',
      round: 1,
      maxRounds: 1,
    });
    await acceptDraftRelease(channel.id, summary.id, 'Final summary');
    await model.advanceDiscussions(channel.id);
    detail = await model.detail(channel.id);
    expect(detail.discussions[0]).toMatchObject({
      turnsPublished: 2,
      status: 'completed',
      endReason: 'limit',
      summaryMessageId: expect.any(String),
    });
    expect(detail.messages.map((m) => m.content)).toEqual([
      'One round only',
      'First answer',
      'Second answer, after reading',
      'Final summary',
    ]);
    expect(detail.jobs.filter((j) => j.task?.kind === 'summarize')).toHaveLength(1);
  });

  it('uses the default number of rounds regardless of audience size', async () => {
    const { channel, a } = await setup();
    const broadcast = await model.send(channel.id, {
      content: 'Everyone weighs in',
      mode: 'discussion',
      mentions: [],
      requestKey: randomUUID(),
    });
    const directed = await model.send(channel.id, {
      content: 'Just you',
      mode: 'discussion',
      mentions: [a.id],
      requestKey: randomUUID(),
    });
    const discussions = (await model.detail(channel.id)).discussions;
    // A round already gives every participant one turn, so the budget is audience-independent.
    expect(discussions.find((d) => d.id === broadcast.id)?.maxRounds).toBe(3);
    expect(discussions.find((d) => d.id === directed.id)?.maxRounds).toBe(3);
  });

  it('treats yield as silence, not consensus, then summarizes quiescence', async () => {
    const { channel, a } = await setup();
    await model.send(channel.id, {
      content: 'Anything else?',
      mode: 'discussion',
      mentions: [a.id],
      requestKey: randomUUID(),
      maxDiscussionRounds: 3,
    });
    const run = (await model.claim(channel.id, (await model.detail(channel.id)).jobs[0].id))!.run;
    expect(await acceptDraftRelease(channel.id, run.id, ' [[CHANNEL_YIELD]] ')).toBeNull();
    expect((await model.detail(channel.id)).messages.map((m) => m.content)).toEqual([
      'Anything else?',
    ]);
    await model.advanceDiscussions(channel.id);
    const detail = await model.detail(channel.id);
    // A round in which nobody published ends the discussion quietly; no further round opens.
    expect(detail.discussions[0]).toMatchObject({
      status: 'summarizing',
      endReason: 'quiet',
      round: 1,
      turnsPublished: 0,
    });
    expect(detail.jobs.filter((j) => j.deliveryKey.startsWith('round:'))).toHaveLength(0);
    expect(
      (await db.select().from(schema.channelRuns).where(eq(schema.channelRuns.id, run.id)))[0]
        .publicationStatus,
    ).toBe('yielded');
    expect(detail.jobs.filter((j) => j.task?.kind === 'summarize')).toHaveLength(1);
  });

  it('explicit stop cannot resurrect work, while a new human request supersedes without stopping its writer', async () => {
    const { channel, a } = await setup();
    await model.send(channel.id, {
      content: 'Autonomy',
      mode: 'discussion',
      mentions: [a.id],
      requestKey: randomUUID(),
    });
    const run = (await model.claim(channel.id, (await model.detail(channel.id)).jobs[0].id))!.run;
    await model.stop(channel.id, { threadId: null });
    await model.releaseWriter(channel.id, run.id, 1);
    await model.advanceDiscussions(channel.id);
    expect((await model.detail(channel.id)).discussions[0]).toMatchObject({
      status: 'stopped',
      endReason: 'stopped',
    });

    const second = await model.send(channel.id, {
      content: 'Old autonomous goal',
      mode: 'discussion',
      mentions: [a.id],
      requestKey: randomUUID(),
    });
    const secondRun = (await model.claim(
      channel.id,
      (await model.detail(channel.id)).jobs.find((j) => j.messageId === second.id)!.id,
    ))!.run;
    await model.send(channel.id, {
      content: 'New human goal',
      mentions: [a.id],
      requestKey: randomUUID(),
    });
    const detail = await model.detail(channel.id);
    expect(detail.discussions.find((d) => d.id === second.id)).toMatchObject({
      status: 'stopped',
      endReason: 'superseded',
    });
    expect(detail.runs.find((r) => r.id === secondRun.id)).toMatchObject({
      publicationRevoked: false,
      writerReleased: false,
      physicalStopped: false,
    });
    expect(detail.discussions).toHaveLength(2); // The new normal message creates no discussion.
    expect(await acceptDraftRelease(channel.id, secondRun.id, 'Late autonomous reply')).toBeNull();
    await model.advanceDiscussions(channel.id);
    expect((await model.detail(channel.id)).messages.map((m) => m.content)).not.toContain(
      'Late autonomous reply',
    );
  });

  it('isolates main/thread freshness and owners', async () => {
    const { channel, a } = await setup();
    const root = await model.send(channel.id, {
      content: 'Root',
      mentions: [a.id],
      requestKey: randomUUID(),
    });
    const rootRun = (await model.claim(channel.id, (await model.detail(channel.id)).jobs[0].id))!
      .run;
    await acceptDraftRelease(channel.id, rootRun.id, 'Root answer');
    const thread = await model.branch(
      channel.id,
      (await model.detail(channel.id)).messages.find((m) => m.content === 'Root answer')!.id,
    );
    const threadRequest = await model.send(channel.id, {
      content: 'Thread question',
      mode: 'discussion',
      mentions: [a.id],
      requestKey: randomUUID(),
      threadId: thread.id,
    });
    const threadRun = (await model.claim(
      channel.id,
      (await model.detail(channel.id)).jobs.find((j) => j.messageId === threadRequest.id)!.id,
    ))!.run;
    await model.send(channel.id, { content: 'Fresh main', mentions: [], requestKey: randomUUID() });
    await model.accepted(channel.id, threadRun.id, 1, 'thread-native', 'thread-turn');
    await model.saveDraft(channel.id, threadRun.id, 1, 'Thread remains fresh');
    expect(await model.publish(channel.id, threadRun.id, 1)).toEqual(expect.any(String));
    expect(threadRun.manifest.messages.map((m) => m.content)).not.toContain('Fresh main');
    expect(root.id).toBeDefined();
    await expect(new ChannelModel(db, 'other').detail(channel.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('opens the next round only after every participant has settled, re-inviting those who yielded', async () => {
    const { channel, a, b } = await setup();
    const [slow] = await model.addMembers(channel.id, [{ name: 'Slow', config }]);
    await model.send(channel.id, {
      content: 'Hear all perspectives',
      mode: 'discussion',
      mentions: [],
      requestKey: randomUUID(),
      maxDiscussionRounds: 3,
    });
    const jobs = (await model.detail(channel.id)).jobs;
    expect(jobs).toHaveLength(3);
    const alpha = (await model.claim(channel.id, jobs.find((j) => j.memberId === a.id)!.id))!.run;
    const slower = (await model.claim(channel.id, jobs.find((j) => j.memberId === slow.id)!.id))!
      .run;
    await acceptDraftRelease(channel.id, alpha.id, 'First');
    // Fast peers are not woken by a publication: Alpha's turn in round 1 is over.
    expect((await model.detail(channel.id)).jobs.filter((j) => j.memberId === a.id)).toHaveLength(
      1,
    );
    const beta = (await model.claim(channel.id, jobs.find((j) => j.memberId === b.id)!.id))!.run;
    await acceptDraftRelease(channel.id, beta.id, 'Second');
    await model.advanceDiscussions(channel.id);
    // Slow is still drafting, so round 1 stays open even though everyone else has spoken.
    expect((await model.detail(channel.id)).discussions[0]).toMatchObject({
      status: 'active',
      round: 1,
      turnsPublished: 2,
    });
    expect(
      await acceptDraftRelease(channel.id, slower.id, 'Old slow draft', 'slow-native'),
    ).toBeNull();
    const revision = (await model.detail(channel.id)).jobs.find(
      (j) => j.memberId === slow.id && j.status === 'queued',
    )!;
    expect(revision.task).toMatchObject({ kind: 'revise', round: 1 });
    await model.advanceDiscussions(channel.id);
    expect((await model.detail(channel.id)).discussions[0].round).toBe(1);
    const revised = (await model.claim(channel.id, revision.id))!;
    expect(revised.session.nativeSessionId).toBe('slow-native');
    expect(
      await acceptDraftRelease(channel.id, revised.run.id, '[[CHANNEL_YIELD]]', 'slow-native'),
    ).toBeNull();

    await model.advanceDiscussions(channel.id);
    let detail = await model.detail(channel.id);
    // Round 1 produced replies, so round 2 opens for all three, including Slow who yielded.
    expect(detail.discussions[0]).toMatchObject({ status: 'active', round: 2, turnsPublished: 2 });
    const secondRound = detail.jobs.filter((j) => j.deliveryKey === 'round:2');
    expect(secondRound.map((j) => j.memberId).sort()).toEqual([a.id, b.id, slow.id].sort());
    expect(secondRound.map((j) => [j.status, j.task])).toEqual(
      Array.from({ length: 3 }, () => ['queued', { kind: 'discuss', round: 2 }]),
    );
    const runs = await Promise.all(
      secondRound.map(async (job) => (await model.claim(channel.id, job.id))!.run),
    );
    expect(runs[0].manifest.discussion).toMatchObject({ kind: 'discuss', round: 2, maxRounds: 3 });
    expect(runs[0].manifest.messages.map((m) => m.content)).toEqual(
      expect.arrayContaining(['First', 'Second']),
    );
    for (const run of runs) await acceptDraftRelease(channel.id, run.id, '[[CHANNEL_YIELD]]');
    await model.advanceDiscussions(channel.id);
    detail = await model.detail(channel.id);
    // A silent round ends the discussion as quiet rather than spending round 3.
    expect(detail.discussions[0]).toMatchObject({
      status: 'summarizing',
      endReason: 'quiet',
      round: 2,
      turnsPublished: 2,
    });
    expect(detail.jobs.filter((j) => j.deliveryKey === 'round:3')).toHaveLength(0);
  });

  it('session reset cancels a held continuation instead of replaying its private draft', async () => {
    const { channel, a, b } = await setup();
    await model.send(channel.id, {
      content: 'Race',
      mode: 'discussion',
      mentions: [],
      requestKey: randomUUID(),
    });
    const jobs = (await model.detail(channel.id)).jobs;
    const first = (await model.claim(channel.id, jobs.find((j) => j.memberId === a.id)!.id))!.run;
    const held = (await model.claim(channel.id, jobs.find((j) => j.memberId === b.id)!.id))!.run;
    await acceptDraftRelease(channel.id, first.id, 'Winner');
    await model.accepted(channel.id, held.id, 1, 'held-native', 'held-turn');
    await model.saveDraft(channel.id, held.id, 1, 'Private held text');
    expect(await model.publish(channel.id, held.id, 1)).toBeNull();
    await model.releaseWriter(channel.id, held.id, 1);
    await model.resetSession(channel.id, b.id, null);
    const revision = (await model.detail(channel.id)).jobs.find((j) => j.task?.kind === 'revise')!;
    expect(await model.claim(channel.id, revision.id)).toBeNull();
    const detail = await model.detail(channel.id);
    expect(
      (await db.select().from(schema.channelJobs).where(eq(schema.channelJobs.id, revision.id)))[0],
    ).toMatchObject({
      status: 'cancelled',
      blockedReason: 'Held draft session changed',
    });
    expect(detail.messages.map((m) => m.content)).not.toContain('Private held text');
  });
});

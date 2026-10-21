import { randomUUID } from 'node:crypto';

import type { ChannelDiscussionTask } from '@lobechat/types';
import { and, asc, eq, gt, inArray, isNull } from 'drizzle-orm';

import {
  channelDiscussions,
  channelJobs,
  channelMembers,
  channelMessages,
  channelRuns,
  channelThreads,
} from '../privateSchemas/channel';
import type { Transaction } from '../type';

type Discussion = typeof channelDiscussions.$inferSelect;
type Run = typeof channelRuns.$inferSelect;

/** Internal transaction helpers. The caller must hold the owner-scoped Channel row lock. */
export async function queueDiscussionTurn(
  tx: Transaction,
  discussion: Discussion,
  memberId: string,
  deliveryKey: string,
  task: ChannelDiscussionTask = { kind: 'discuss' },
) {
  const [member] = await tx.select().from(channelMembers).where(eq(channelMembers.id, memberId));
  const [request] = await tx
    .select()
    .from(channelMessages)
    .where(eq(channelMessages.id, discussion.requestMessageId));
  if (
    !member?.active ||
    member.channelId !== discussion.channelId ||
    request.sequence <= member.environmentCutoff
  )
    return;
  if (discussion.threadId) {
    const [thread] = await tx
      .select()
      .from(channelThreads)
      .where(eq(channelThreads.id, discussion.threadId));
    if (!thread?.followerMemberIds.includes(memberId)) return;
  }
  const [queued] = await tx
    .select()
    .from(channelJobs)
    .where(
      and(
        eq(channelJobs.discussionId, discussion.id),
        eq(channelJobs.memberId, memberId),
        eq(channelJobs.status, 'queued'),
      ),
    );
  // All updates will be read at claim time; retain a held candidate when wakes coalesce.
  if (queued) {
    if (task.kind === 'revise')
      await tx.update(channelJobs).set({ task }).where(eq(channelJobs.id, queued.id));
    return;
  }
  await tx
    .insert(channelJobs)
    .values({
      id: `chn_job_${randomUUID()}`,
      channelId: discussion.channelId,
      messageId: discussion.requestMessageId,
      threadId: discussion.threadId,
      memberId,
      discussionId: discussion.id,
      deliveryKey,
      task,
    })
    .onConflictDoNothing();
}

export async function stopDiscussions(
  tx: Transaction,
  channelId: string,
  threadId: string | null,
  reason: string,
) {
  const stopped = await tx
    .update(channelDiscussions)
    .set({ status: 'stopped', endReason: reason })
    .where(
      and(
        eq(channelDiscussions.channelId, channelId),
        threadId ? eq(channelDiscussions.threadId, threadId) : isNull(channelDiscussions.threadId),
        inArray(channelDiscussions.status, ['active', 'summarizing']),
      ),
    )
    .returning({ id: channelDiscussions.id });
  if (stopped.length)
    await tx
      .update(channelJobs)
      .set({ status: 'cancelled' })
      .where(
        and(
          inArray(
            channelJobs.discussionId,
            stopped.map((d) => d.id),
          ),
          eq(channelJobs.status, 'queued'),
        ),
      );
}

/**
 * Settles a discussion candidate that may not be published now and reports how, or returns null
 * when it may be. Checking freshness and inserting the candidate share the caller's Channel lock;
 * input dedup cursors never confer authority on an older immutable candidate.
 */
export async function gateDiscussionCandidate(tx: Transaction, run: Run, discussion: Discussion) {
  const task = run.manifest.discussion!;
  const summarizing = task.kind === 'summarize';
  const live = discussion.status === (summarizing ? 'summarizing' : 'active');
  const unseen = await tx
    .select({ id: channelMessages.id })
    .from(channelMessages)
    .where(
      and(
        eq(channelMessages.channelId, run.channelId),
        gt(channelMessages.sequence, run.manifest.cutoffSequence),
        run.manifest.threadId
          ? eq(channelMessages.threadId, run.manifest.threadId)
          : isNull(channelMessages.threadId),
      ),
    )
    .orderBy(asc(channelMessages.sequence));
  // Turns in a round are parallel: a peer's reply in this same round is read in the next round
  // and never holds this candidate. Any other unseen message still does.
  const sameRound = new Set(
    !summarizing && unseen.length
      ? (
          await tx
            .select({ messageId: channelRuns.publishedMessageId, task: channelJobs.task })
            .from(channelRuns)
            .innerJoin(channelJobs, eq(channelJobs.id, channelRuns.jobId))
            .where(
              and(
                eq(channelRuns.channelId, run.channelId),
                eq(channelJobs.discussionId, discussion.id),
                inArray(
                  channelRuns.publishedMessageId,
                  unseen.map((message) => message.id),
                ),
              ),
            )
        )
          .filter((peer) => peer.task?.round === task.round)
          .map((peer) => peer.messageId)
      : [],
  );
  const newer = unseen.find((message) => !sameRound.has(message.id));
  const yielded = !summarizing && run.draft?.trim() === '[[CHANNEL_YIELD]]';
  // A candidate may only publish in the round it was claimed for. The round cannot advance
  // while its writer is live, so this only catches publication after release.
  const stale = !summarizing && task.round !== discussion.round;
  if (live && !newer && !yielded && !stale) return null;
  const publicationStatus: 'held' | 'yielded' = !live || newer || stale ? 'held' : 'yielded';
  await tx.update(channelRuns).set({ publicationStatus }).where(eq(channelRuns.id, run.id));
  await tx.update(channelJobs).set({ status: 'completed' }).where(eq(channelJobs.id, run.jobId));
  // A revision keeps this member's turn open within the same round.
  if (live && newer && !summarizing && !stale)
    await queueDiscussionTurn(tx, discussion, run.memberId, `held:${run.id}`, {
      kind: 'revise',
      previousRunId: run.id,
      round: discussion.round,
    });
  return { publicationStatus, newerMessageId: newer?.id };
}

/** Records a published candidate: a summary completes the discussion, a turn counts toward it. */
export async function recordDiscussionPublication(
  tx: Transaction,
  discussion: Discussion,
  run: Run,
  messageId: string,
) {
  if (run.manifest.discussion!.kind === 'summarize') {
    await tx
      .update(channelDiscussions)
      .set({ status: 'completed', summaryMessageId: messageId })
      .where(eq(channelDiscussions.id, discussion.id));
    return;
  }
  // Peers are not woken here: they answer in the next round, which advanceDiscussions opens once
  // every turn of this round has settled. Slower peers still drafting in this round publish their
  // own turn and read this message in the next round.
  await tx
    .update(channelDiscussions)
    .set({ turnsPublished: discussion.turnsPublished + 1 })
    .where(eq(channelDiscussions.id, discussion.id));
}

/**
 * Called after reconciliation, also after a restart. No in-memory timers or wake counters.
 *
 * A round is one turn for every participant, running concurrently with no speaking order; a
 * peer's reply in the same round does not hold another turn. The round is over once no job in
 * the discussion is queued or running and every run has released its writer or been isolated.
 * A round with at least one publication opens the next one for all participants, including those
 * who yielded; a silent round or the last round ends the discussion with a summary.
 */
export async function advanceDiscussions(tx: Transaction, channelId: string) {
  const discussions = await tx
    .select()
    .from(channelDiscussions)
    .where(
      and(
        eq(channelDiscussions.channelId, channelId),
        inArray(channelDiscussions.status, ['active', 'summarizing']),
      ),
    );
  for (const discussion of discussions) {
    const jobs = await tx
      .select()
      .from(channelJobs)
      .where(eq(channelJobs.discussionId, discussion.id));
    const runs = jobs.length
      ? await tx
          .select()
          .from(channelRuns)
          .where(
            inArray(
              channelRuns.jobId,
              jobs.map((j) => j.id),
            ),
          )
          .orderBy(asc(channelRuns.createdAt))
      : [];
    if (
      jobs.some((job) => ['queued', 'running'].includes(job.status)) ||
      runs.some((run) => !run.writerReleased && !run.isolatedAt)
    )
      continue;
    if (discussion.status === 'summarizing') {
      // A failed/stopped summary must not silently become "consensus" or replay side effects.
      await tx
        .update(channelDiscussions)
        .set({ status: 'stopped', endReason: 'summary_failed' })
        .where(eq(channelDiscussions.id, discussion.id));
      continue;
    }
    const roundJobs = new Set(
      jobs.filter((job) => job.task?.round === discussion.round).map((job) => job.id),
    );
    const publishedThisRound = runs.some(
      (run) => run.publishedMessageId && roundJobs.has(run.jobId),
    );
    if (publishedThisRound && discussion.round < discussion.maxRounds) {
      const round = discussion.round + 1;
      await tx
        .update(channelDiscussions)
        .set({ round })
        .where(eq(channelDiscussions.id, discussion.id));
      for (const memberId of discussion.participantIds)
        await queueDiscussionTurn(tx, { ...discussion, round }, memberId, `round:${round}`, {
          kind: 'discuss',
          round,
        });
      continue;
    }
    const members = await tx
      .select()
      .from(channelMembers)
      .where(
        and(
          eq(channelMembers.channelId, channelId),
          eq(channelMembers.active, true),
          eq(channelMembers.executionPaused, false),
        ),
      );
    const eligible = members.filter((member) => discussion.participantIds.includes(member.id));
    const recentAuthor = runs.findLast((run) => run.publishedMessageId)?.memberId;
    const summarizer = eligible.find((member) => member.id === recentAuthor) || eligible[0];
    const reason = publishedThisRound ? 'limit' : 'quiet';
    if (!summarizer) {
      await tx
        .update(channelDiscussions)
        .set({ status: 'stopped', endReason: 'unavailable' })
        .where(eq(channelDiscussions.id, discussion.id));
      continue;
    }
    await queueDiscussionTurn(tx, discussion, summarizer.id, 'summary', { kind: 'summarize' });
    await tx
      .update(channelDiscussions)
      .set({ status: 'summarizing', endReason: reason })
      .where(eq(channelDiscussions.id, discussion.id));
  }
}

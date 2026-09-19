import { randomUUID } from 'node:crypto';

import type { ChannelDiscussionTask } from '@lobechat/types';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';

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
        inArray(channelDiscussions.status, ['pending', 'active', 'summarizing']),
      ),
    )
    .returning({
      id: channelDiscussions.id,
      requestMessageId: channelDiscussions.requestMessageId,
    });
  if (stopped.length) {
    // Cancel the decision as well, so an in-flight Jev result cannot start a superseded round.
    await tx
      .update(channelMessages)
      .set({ routingStatus: 'unassigned', routingReason: `Discussion ${reason}` })
      .where(
        and(
          inArray(
            channelMessages.id,
            stopped.map((discussion) => discussion.requestMessageId),
          ),
          eq(channelMessages.routingStatus, 'pending'),
        ),
      );
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
}

/**
 * Called after reconciliation, also after a restart. No in-memory timers or wake counters.
 *
 * A round is one turn for every participant, running concurrently with no speaking order. It is
 * over once no job in the discussion is queued or running and every run has released its writer.
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
      runs.some((run) => !run.writerReleased)
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

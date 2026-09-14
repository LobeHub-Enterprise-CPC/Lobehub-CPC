import { createHash } from 'node:crypto';

import { CHANNEL_HISTORY } from '@lobechat/types';
import {
  and,
  asc,
  count,
  desc,
  eq,
  getTableColumns,
  inArray,
  isNull,
  lt,
  or,
  sql,
} from 'drizzle-orm';

import {
  channelApprovals,
  channelDiscussions,
  channelJobs,
  channelMembers,
  channelMessages,
  channelRuns,
  channels,
  channelThreads,
} from '../privateSchemas/channel';
import type { LobeChatDatabase } from '../type';

export interface ChannelPageOptions {
  before?: number;
  threadId?: string | null;
}

const unsettledRun = or(
  eq(channelRuns.writerReleased, false),
  eq(channelRuns.physicalStopped, false),
);
const pendingJob = inArray(channelJobs.status, ['queued', 'running']);
const activeDiscussion = inArray(channelDiscussions.status, ['active', 'summarizing']);

const runSummary = {
  id: channelRuns.id,
  jobId: channelRuns.jobId,
  memberId: channelRuns.memberId,
  status: channelRuns.status,
  activity: channelRuns.activity,
  acceptance: channelRuns.acceptance,
  publicationStatus: channelRuns.publicationStatus,
  publicationRevoked: channelRuns.publicationRevoked,
  writerReleased: channelRuns.writerReleased,
  executionConfig: channelRuns.executionConfig,
  physicalStopped: channelRuns.physicalStopped,
  environmentError: channelRuns.environmentError,
  manifest: {
    threadId: channelJobs.threadId,
    requestMessageId: channelJobs.messageId,
  },
  publishedMessageId: channelRuns.publishedMessageId,
  error: channelRuns.error,
};

const fingerprint = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** The caller has checked ownership; these reads never load private transcripts or manifests. */
export async function readChannelRevision(
  db: LobeChatDatabase,
  channel: typeof channels.$inferSelect,
) {
  const channelId = channel.id;
  const [members, threads, jobs, runs, discussions, approvals, routing] = await Promise.all([
    db
      .select()
      .from(channelMembers)
      .where(eq(channelMembers.channelId, channelId))
      .orderBy(asc(channelMembers.id)),
    db
      .select({ id: channelThreads.id, followers: channelThreads.followerMemberIds })
      .from(channelThreads)
      .where(eq(channelThreads.channelId, channelId))
      .orderBy(asc(channelThreads.id)),
    db
      .select()
      .from(channelJobs)
      .where(and(eq(channelJobs.channelId, channelId), pendingJob))
      .orderBy(asc(channelJobs.id)),
    db
      .select(runSummary)
      .from(channelRuns)
      .innerJoin(channelJobs, eq(channelJobs.id, channelRuns.jobId))
      .where(and(eq(channelRuns.channelId, channelId), unsettledRun))
      .orderBy(asc(channelRuns.id)),
    db
      .select()
      .from(channelDiscussions)
      .where(and(eq(channelDiscussions.channelId, channelId), activeDiscussion))
      .orderBy(asc(channelDiscussions.id)),
    db
      .select({ id: channelApprovals.id, decision: channelApprovals.decision })
      .from(channelApprovals)
      .innerJoin(channelRuns, eq(channelRuns.id, channelApprovals.runId))
      .where(and(eq(channelRuns.channelId, channelId), unsettledRun))
      .orderBy(asc(channelApprovals.id)),
    db
      .select({ id: channelMessages.id })
      .from(channelMessages)
      .where(
        and(eq(channelMessages.channelId, channelId), eq(channelMessages.routingStatus, 'pending')),
      )
      .orderBy(asc(channelMessages.id)),
  ]);
  return {
    navigationRevision: fingerprint([
      channel.title,
      channel.archived,
      threads.map((thread) => thread.id),
    ]),
    revision: fingerprint([channel, members, threads, jobs, runs, discussions, approvals, routing]),
  };
}

export async function readChannelPage(
  db: LobeChatDatabase,
  channel: typeof channels.$inferSelect,
  options: ChannelPageOptions,
) {
  const channelId = channel.id;
  const threadId = options.threadId ?? null;
  const [page, members, threads, liveRuns, latestRequests] = await Promise.all([
    db
      .select()
      .from(channelMessages)
      .where(
        and(
          eq(channelMessages.channelId, channelId),
          threadId ? eq(channelMessages.threadId, threadId) : isNull(channelMessages.threadId),
          options.before === undefined ? undefined : lt(channelMessages.sequence, options.before),
        ),
      )
      .orderBy(desc(channelMessages.sequence))
      .limit(CHANNEL_HISTORY.pageSize + 1),
    db
      .select()
      .from(channelMembers)
      .where(eq(channelMembers.channelId, channelId))
      .orderBy(asc(channelMembers.createdAt)),
    db
      .select()
      .from(channelThreads)
      .where(eq(channelThreads.channelId, channelId))
      .orderBy(asc(channelThreads.createdAt)),
    db
      .select(runSummary)
      .from(channelRuns)
      .innerJoin(channelJobs, eq(channelJobs.id, channelRuns.jobId))
      .where(and(eq(channelRuns.channelId, channelId), unsettledRun)),
    db
      .select({ id: channelMessages.id })
      .from(channelMessages)
      .where(
        and(
          eq(channelMessages.channelId, channelId),
          isNull(channelMessages.authorMemberId),
          threadId ? eq(channelMessages.threadId, threadId) : isNull(channelMessages.threadId),
        ),
      )
      .orderBy(desc(channelMessages.sequence))
      .limit(1),
  ]);
  const messages = page.slice(0, CHANNEL_HISTORY.pageSize).reverse();
  const messageIds = messages.map((message) => message.id);
  const jobs = await db
    .select()
    .from(channelJobs)
    .where(
      and(
        eq(channelJobs.channelId, channelId),
        or(
          inArray(channelJobs.messageId, [
            ...messageIds,
            ...latestRequests.map((message) => message.id),
          ]),
          pendingJob,
          inArray(
            channelJobs.id,
            liveRuns.map((run) => run.jobId),
          ),
        ),
      ),
    );
  const selectedThread = threads.find((thread) => thread.id === threadId);
  const contextIds = [
    ...new Set([
      ...jobs.map((job) => job.messageId),
      ...latestRequests.map((message) => message.id),
      ...(selectedThread ? [selectedThread.rootMessageId] : []),
    ]),
  ].filter((id) => !messageIds.includes(id));
  const visibleThreadIds = threads
    .filter((thread) => thread.id === threadId || messageIds.includes(thread.rootMessageId))
    .map((thread) => thread.id);
  const [runs, contextMessages, discussions, approvals, replyCounts] = await Promise.all([
    db
      .select(runSummary)
      .from(channelRuns)
      .innerJoin(channelJobs, eq(channelJobs.id, channelRuns.jobId))
      .where(
        and(
          eq(channelRuns.channelId, channelId),
          inArray(
            channelRuns.jobId,
            jobs.map((job) => job.id),
          ),
        ),
      ),
    db
      .select()
      .from(channelMessages)
      .where(and(eq(channelMessages.channelId, channelId), inArray(channelMessages.id, contextIds)))
      .orderBy(asc(channelMessages.sequence)),
    db
      .select()
      .from(channelDiscussions)
      .where(
        and(
          eq(channelDiscussions.channelId, channelId),
          or(
            inArray(channelDiscussions.requestMessageId, [...messageIds, ...contextIds]),
            activeDiscussion,
          ),
        ),
      ),
    db
      .select({
        id: channelApprovals.id,
        runId: channelApprovals.runId,
        request: channelApprovals.request,
        decision: channelApprovals.decision,
        expiresAt: channelApprovals.expiresAt,
      })
      .from(channelApprovals)
      .innerJoin(channelRuns, eq(channelRuns.id, channelApprovals.runId))
      .where(
        and(
          eq(channelRuns.channelId, channelId),
          inArray(
            channelRuns.jobId,
            jobs.map((job) => job.id),
          ),
        ),
      ),
    db
      .select({ threadId: channelMessages.threadId, count: count() })
      .from(channelMessages)
      .where(
        and(
          eq(channelMessages.channelId, channelId),
          inArray(channelMessages.threadId, visibleThreadIds),
        ),
      )
      .groupBy(channelMessages.threadId),
  ]);
  return {
    channel,
    members,
    threads,
    messages,
    contextMessages,
    discussions,
    jobs: jobs.map((job) => ({
      ...job,
      blockedReason: job.status === 'queued' ? job.blockedReason : undefined,
    })),
    runs,
    approvals,
    replyCounts,
    before: options.before,
    threadId,
    nextCursor: page.length > CHANNEL_HISTORY.pageSize ? messages[0].sequence : null,
  };
}

/** One query for all of the owner's thread navigation, without message bodies or execution data. */
export function listChannelThreads(db: LobeChatDatabase, ownerId: string) {
  return db
    .select({
      ...getTableColumns(channelThreads),
      title: sql<string>`left(split_part(trim(${channelMessages.content}), E'\\n', 1), 160)`,
    })
    .from(channelThreads)
    .innerJoin(channels, eq(channels.id, channelThreads.channelId))
    .innerJoin(channelMessages, eq(channelMessages.id, channelThreads.rootMessageId))
    .where(eq(channels.ownerId, ownerId))
    .orderBy(asc(channelThreads.createdAt));
}

import { randomUUID } from 'node:crypto';

import type { ChannelInputManifest, ChannelMemberConfig, ChannelMode } from '@lobechat/types';
import { CHANNEL_LIMITS } from '@lobechat/types';
import { and, asc, desc, eq, gt, inArray, isNull, lte, ne, or } from 'drizzle-orm';

import {
  channelApprovals,
  channelAudit,
  channelDiscussions,
  channelJobs,
  channelMembers,
  channelMessages,
  channelOutbox,
  channelRuns,
  channels,
  channelSessions,
  channelThreads,
} from '../privateSchemas/channel';
import { files } from '../schemas/file';
import type { LobeChatDatabase, Transaction } from '../type';
import { buildWorkspaceWhere } from '../utils/workspace';
import { advanceDiscussions, queueDiscussionTurn, stopDiscussions } from './channelDiscussion';
import type { ChannelPageOptions } from './channelRead';
import { listChannelThreads, readChannelPage, readChannelRevision } from './channelRead';

type DB = LobeChatDatabase | Transaction;
const id = (kind: string) => `chn_${kind}_${randomUUID()}`;

export class ChannelError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'CONFLICT' | 'BAD_REQUEST',
    message: string,
  ) {
    super(message);
  }
}

/** All channel mutations serialize on the owner-scoped Channel row. */
export class ChannelModel {
  constructor(
    private readonly db: LobeChatDatabase,
    private readonly ownerId: string,
  ) {}

  private async owned(db: DB, channelId: string, write = false, allowArchived = false) {
    const query = db
      .select()
      .from(channels)
      .where(and(eq(channels.id, channelId), eq(channels.ownerId, this.ownerId)));
    const [channel] = await (write ? query.for('update') : query);
    if (!channel) throw new ChannelError('NOT_FOUND', 'Channel not found');
    if (write && channel.archived && !allowArchived)
      throw new ChannelError('CONFLICT', 'Channel is archived');
    return channel;
  }

  private async audit(
    db: DB,
    channelId: string,
    event: string,
    targetId: string,
    details: Record<string, unknown> = {},
  ) {
    await db.insert(channelAudit).values({ id: id('audit'), channelId, event, targetId, details });
  }

  private async outbox(
    db: DB,
    channelId: string,
    kind: 'route' | 'execute' | 'publish' | 'stop',
    targetId: string,
  ) {
    await db.insert(channelOutbox).values({ id: id('outbox'), channelId, kind, targetId });
  }

  list = () =>
    this.db
      .select()
      .from(channels)
      .where(and(eq(channels.ownerId, this.ownerId), eq(channels.archived, false)))
      .orderBy(desc(channels.createdAt));

  async listWithThreads() {
    const [items, threads] = await Promise.all([
      this.list(),
      listChannelThreads(this.db, this.ownerId),
    ]);
    const byChannel = new Map<string, typeof threads>();
    for (const thread of threads) {
      const list = byChannel.get(thread.channelId) ?? [];
      list.push(thread);
      byChannel.set(thread.channelId, list);
    }
    return items.map((channel) => ({ ...channel, threads: byChannel.get(channel.id) ?? [] }));
  }

  async revision(channelId: string) {
    const channel = await this.owned(this.db, channelId);
    if (channel.archived) throw new ChannelError('NOT_FOUND', 'Channel not found');
    return readChannelRevision(this.db, channel);
  }

  async page(channelId: string, options: ChannelPageOptions = {}) {
    const channel = await this.owned(this.db, channelId);
    if (channel.archived) throw new ChannelError('NOT_FOUND', 'Channel not found');
    if (options.threadId) {
      const [thread] = await this.db
        .select({ id: channelThreads.id })
        .from(channelThreads)
        .where(
          and(eq(channelThreads.channelId, channelId), eq(channelThreads.id, options.threadId)),
        );
      if (!thread) throw new ChannelError('NOT_FOUND', 'Thread not found');
    }
    return readChannelPage(this.db, channel, options);
  }

  private validateMembers(members: { config: ChannelMemberConfig }[]) {
    const configs = members.map((member) => member.config);
    const agentIds = configs.map((config) => config.agentId).filter(Boolean);
    if (new Set(agentIds).size !== agentIds.length)
      throw new ChannelError('BAD_REQUEST', 'This Agent is already a member of the Channel');
  }

  async create(
    title: string,
    members: { name: string; description?: string; config: ChannelMemberConfig }[],
  ) {
    if (
      !title.trim() ||
      members.length < CHANNEL_LIMITS.minMembers ||
      members.length > CHANNEL_LIMITS.members
    )
      throw new ChannelError(
        'BAD_REQUEST',
        `A Channel requires a title and ${CHANNEL_LIMITS.minMembers} to ${CHANNEL_LIMITS.members} members`,
      );
    this.validateMembers(members);
    return this.db.transaction(async (tx) => {
      const channelId = id('channel');
      const [channel] = await tx
        .insert(channels)
        .values({ id: channelId, ownerId: this.ownerId, title: title.trim() })
        .returning();
      await tx
        .insert(channelMembers)
        .values(members.map((m) => ({ ...m, id: id('member'), channelId })));
      await this.audit(tx, channelId, 'created', channelId);
      return channel;
    });
  }

  async detail(channelId: string) {
    const channel = await this.owned(this.db, channelId);
    const discussions = await this.db
      .select()
      .from(channelDiscussions)
      .where(eq(channelDiscussions.channelId, channelId))
      .orderBy(asc(channelDiscussions.createdAt));
    const [members, threads, messages, jobs, runs] = await Promise.all([
      this.db
        .select()
        .from(channelMembers)
        .where(eq(channelMembers.channelId, channelId))
        .orderBy(asc(channelMembers.createdAt)),
      this.db.select().from(channelThreads).where(eq(channelThreads.channelId, channelId)),
      this.db
        .select()
        .from(channelMessages)
        .where(eq(channelMessages.channelId, channelId))
        .orderBy(asc(channelMessages.sequence)),
      this.db.select().from(channelJobs).where(eq(channelJobs.channelId, channelId)),
      this.db
        .select({
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
          manifest: channelRuns.manifest,
          publishedMessageId: channelRuns.publishedMessageId,
          error: channelRuns.error,
        })
        .from(channelRuns)
        .where(eq(channelRuns.channelId, channelId)),
    ]);
    const approvals = await this.db
      .select({
        id: channelApprovals.id,
        runId: channelApprovals.runId,
        request: channelApprovals.request,
        decision: channelApprovals.decision,
        expiresAt: channelApprovals.expiresAt,
      })
      .from(channelApprovals)
      .innerJoin(channelRuns, eq(channelRuns.id, channelApprovals.runId))
      .where(eq(channelRuns.channelId, channelId));
    const artifacts = await this.db
      .select()
      .from(channelAudit)
      .where(
        and(eq(channelAudit.channelId, channelId), eq(channelAudit.event, 'workspace_snapshot')),
      );
    return {
      channel,
      discussions,
      members,
      threads,
      messages,
      jobs: jobs.map((job) => ({
        ...job,
        blockedReason: job.status === 'queued' ? job.blockedReason : undefined,
      })),
      runs,
      approvals,
      artifacts: artifacts.map((artifact) => ({
        runId: artifact.targetId,
        sha256: artifact.details.sha256,
        baselineCommit: artifact.details.baselineCommit,
      })),
    };
  }

  async addMembers(
    channelId: string,
    members: { name: string; description?: string; config: ChannelMemberConfig }[],
  ) {
    return this.db.transaction(async (tx) => {
      await this.owned(tx, channelId, true);
      const active = await tx
        .select()
        .from(channelMembers)
        .where(and(eq(channelMembers.channelId, channelId), eq(channelMembers.active, true)));
      if (!members.length || active.length + members.length > CHANNEL_LIMITS.members)
        throw new ChannelError(
          'BAD_REQUEST',
          `A Channel supports at most ${CHANNEL_LIMITS.members} active members`,
        );
      this.validateMembers([...active, ...members]);
      const added = await tx
        .insert(channelMembers)
        .values(members.map((member) => ({ ...member, channelId, id: id('member') })))
        .returning();
      await this.audit(tx, channelId, 'members_added', channelId, {
        memberIds: added.map((member) => member.id),
      });
      return added;
    });
  }

  /** Permission revocation and cancellation share the Channel lock with claim/publication. */
  async retire(channelId: string, memberId?: string) {
    await this.db.transaction(async (tx) => {
      await this.owned(tx, channelId, true, true);
      if (memberId) {
        const [member] = await tx
          .select()
          .from(channelMembers)
          .where(and(eq(channelMembers.id, memberId), eq(channelMembers.channelId, channelId)));
        if (!member) throw new ChannelError('NOT_FOUND', 'Member not found');
        await tx
          .update(channelMembers)
          .set({ active: false })
          .where(eq(channelMembers.id, memberId));
      } else {
        await tx.update(channels).set({ archived: true }).where(eq(channels.id, channelId));
        await tx
          .update(channelMessages)
          .set({ routingStatus: 'unassigned', routingReason: 'Channel archived' })
          .where(
            and(
              eq(channelMessages.channelId, channelId),
              eq(channelMessages.routingStatus, 'pending'),
            ),
          );
      }
      await tx
        .update(channelJobs)
        .set({ status: 'cancelled' })
        .where(
          and(
            eq(channelJobs.channelId, channelId),
            memberId ? eq(channelJobs.memberId, memberId) : undefined,
            inArray(channelJobs.status, ['queued', 'running']),
          ),
        );
      const runs = await tx
        .select()
        .from(channelRuns)
        .where(
          and(
            eq(channelRuns.channelId, channelId),
            memberId ? eq(channelRuns.memberId, memberId) : undefined,
          ),
        );
      for (const run of runs) {
        const revoke = !run.publicationRevoked && (!run.writerReleased || !run.publishedMessageId);
        if (!revoke && run.physicalStopped) continue;
        await tx
          .update(channelRuns)
          .set({
            cleanupRequested: !run.physicalStopped,
            ...(revoke && {
              publicationRevoked: true,
              status: run.writerReleased ? 'stopped' : 'stop_requested',
            }),
          })
          .where(eq(channelRuns.id, run.id));
        if (revoke && !run.writerReleased) await this.outbox(tx, channelId, 'stop', run.id);
      }
      await this.audit(
        tx,
        channelId,
        memberId ? 'member_removed' : 'archived',
        memberId || channelId,
      );
    });
  }

  private async scope(db: DB, channelId: string, threadId?: string | null) {
    if (!threadId) return null;
    const [thread] = await db
      .select()
      .from(channelThreads)
      .where(and(eq(channelThreads.channelId, channelId), eq(channelThreads.id, threadId)));
    if (!thread) throw new ChannelError('NOT_FOUND', 'Thread not found');
    return thread;
  }

  private async targets(db: DB, channelId: string, memberIds: string[]) {
    const unique = [...new Set(memberIds)];
    if (unique.length === 0) return [];
    const members = await db
      .select()
      .from(channelMembers)
      .where(
        and(
          eq(channelMembers.channelId, channelId),
          eq(channelMembers.active, true),
          inArray(channelMembers.id, unique),
        ),
      );
    if (members.length !== unique.length)
      throw new ChannelError('BAD_REQUEST', 'A selected member is unavailable');
    return members;
  }

  private async deliver(db: DB, message: typeof channelMessages.$inferSelect, memberIds: string[]) {
    const members = await this.targets(db, message.channelId, memberIds);
    for (const member of members) {
      // Late routing/retry cannot run an old instruction in a newly selected directory.
      if (message.sequence <= member.environmentCutoff) continue;
      const memberId = member.id;
      const [job] = await db
        .insert(channelJobs)
        .values({
          id: id('job'),
          channelId: message.channelId,
          memberId,
          messageId: message.id,
          threadId: message.threadId,
        })
        .onConflictDoNothing()
        .returning();
      if (job) await this.outbox(db, message.channelId, 'execute', job.id);
    }
  }

  async send(
    channelId: string,
    input: {
      content: string;
      fileIds?: string[];
      mentions: string[];
      requestKey: string;
      threadId?: string | null;
      mode?: ChannelMode;
      maxDiscussionRounds?: number;
    },
  ) {
    const discussing = input.mode === 'discussion';
    if (
      discussing &&
      input.maxDiscussionRounds !== undefined &&
      (!Number.isInteger(input.maxDiscussionRounds) ||
        input.maxDiscussionRounds < 1 ||
        input.maxDiscussionRounds > CHANNEL_LIMITS.maxDiscussionRounds)
    )
      throw new ChannelError(
        'BAD_REQUEST',
        `Discussion rounds must be an integer from 1 to ${CHANNEL_LIMITS.maxDiscussionRounds}`,
      );
    const fileIds = [...new Set(input.fileIds ?? [])];
    if (
      (!input.content.trim() && !fileIds.length) ||
      !input.requestKey ||
      input.content.length > 100_000 ||
      fileIds.length > CHANNEL_LIMITS.attachments
    )
      throw new ChannelError(
        'BAD_REQUEST',
        'A message requires bounded content and a retry identity',
      );
    return this.db.transaction(async (tx) => {
      const channel = await this.owned(tx, channelId, true);
      const thread = await this.scope(tx, channelId, input.threadId);
      const mentions = [...new Set(input.mentions)];
      const [existing] = await tx
        .select()
        .from(channelMessages)
        .where(
          and(
            eq(channelMessages.channelId, channelId),
            eq(channelMessages.requestKey, input.requestKey),
          ),
        );
      if (existing) {
        const [discussion] = await tx
          .select()
          .from(channelDiscussions)
          .where(eq(channelDiscussions.requestMessageId, existing.id));
        if (
          existing.content !== input.content ||
          existing.threadId !== (input.threadId || null) ||
          JSON.stringify(existing.fileIds) !== JSON.stringify(fileIds) ||
          JSON.stringify(existing.mentions) !== JSON.stringify(mentions) ||
          Boolean(discussion) !== (discussing && existing.routingStatus !== 'unassigned') ||
          (discussion &&
            input.maxDiscussionRounds !== undefined &&
            discussion.maxRounds !== input.maxDiscussionRounds)
        )
          throw new ChannelError(
            'CONFLICT',
            'Retry identity was already used for a different message',
          );
        return existing;
      }
      if (fileIds.length) {
        // Use a stable lock order so concurrent sends/cleanup serialize without deadlocks.
        const orderedFileIds = [...fileIds].sort();
        const accessible = await tx
          .select({ id: files.id })
          .from(files)
          .where(
            and(
              inArray(files.id, orderedFileIds),
              buildWorkspaceWhere({ userId: this.ownerId }, files),
            ),
          )
          .orderBy(asc(files.id))
          .for('update');
        if (accessible.length !== fileIds.length)
          throw new ChannelError('BAD_REQUEST', 'One or more attachments are unavailable');
      }
      // A new human goal supersedes autonomous follow-ups, without killing native background work.
      await stopDiscussions(tx, channelId, input.threadId || null, 'superseded');
      await this.targets(tx, channelId, mentions);
      if (thread && mentions.length)
        await tx
          .update(channelThreads)
          .set({ followerMemberIds: [...new Set([...thread.followerMemberIds, ...mentions])] })
          .where(eq(channelThreads.id, thread.id));
      // Resolve the audience while holding the Channel lock, in the same transaction as send.
      // Availability affects execution, never whether a member receives a public request.
      const audience = mentions.length
        ? mentions
        : (
            await tx
              .select({ id: channelMembers.id })
              .from(channelMembers)
              .where(and(eq(channelMembers.channelId, channelId), eq(channelMembers.active, true)))
          )
            .filter((member) => !thread || thread.followerMemberIds.includes(member.id))
            .map((member) => member.id);
      const [message] = await tx
        .insert(channelMessages)
        .values({
          id: id('msg'),
          channelId,
          threadId: input.threadId || null,
          sequence: channel.sequence + 1,
          content: input.content,
          fileIds,
          mentions,
          requestKey: input.requestKey,
          routingStatus: mentions.length ? 'directed' : audience.length ? 'assigned' : 'unassigned',
          routingReason: mentions.length
            ? 'Mentioned members'
            : thread
              ? 'Thread followers'
              : 'All active members',
        })
        .returning();
      await tx
        .update(channels)
        .set({ sequence: message.sequence })
        .where(eq(channels.id, channelId));
      await this.deliver(tx, message, audience);
      if (discussing && audience.length) {
        // A round already gives every participant one turn, so the budget is audience-independent.
        await tx.insert(channelDiscussions).values({
          id: message.id,
          channelId,
          requestMessageId: message.id,
          threadId: message.threadId,
          participantIds: audience,
          maxRounds: input.maxDiscussionRounds ?? CHANNEL_LIMITS.discussionRounds,
        });
        // The initial delivery jobs are round 1.
        await tx
          .update(channelJobs)
          .set({ discussionId: message.id, task: { kind: 'discuss', round: 1 } })
          .where(eq(channelJobs.messageId, message.id));
      }
      await this.audit(tx, channelId, 'message_accepted', message.id, { mentions, audience });
      return message;
    });
  }

  async recall(channelId: string, messageId: string, memberId: string) {
    await this.db.transaction(async (tx) => {
      await this.owned(tx, channelId, true);
      const [message] = await tx
        .select()
        .from(channelMessages)
        .where(and(eq(channelMessages.channelId, channelId), eq(channelMessages.id, messageId)));
      if (!message || message.authorMemberId)
        throw new ChannelError('BAD_REQUEST', 'Recall must reference the original human request');
      await this.deliver(tx, message, [memberId]);
      // A manual assignment wins over an in-flight recommendation without rewriting mentions.
      if (['pending', 'unassigned'].includes(message.routingStatus))
        await tx
          .update(channelMessages)
          .set({ routingStatus: 'assigned', routingReason: 'Manually assigned' })
          .where(eq(channelMessages.id, messageId));
      await this.audit(tx, channelId, 'member_recalled', messageId, { memberId });
    });
  }

  async routingInput(channelId: string, messageId: string) {
    await this.owned(this.db, channelId);
    const [message] = await this.db
      .select()
      .from(channelMessages)
      .where(and(eq(channelMessages.channelId, channelId), eq(channelMessages.id, messageId)));
    if (!message || message.routingStatus !== 'pending') return null;
    const thread = await this.scope(this.db, channelId, message.threadId);
    const [members, recent] = await Promise.all([
      this.db
        .select()
        .from(channelMembers)
        .where(and(eq(channelMembers.channelId, channelId), eq(channelMembers.active, true))),
      this.db
        .select()
        .from(channelMessages)
        .where(
          and(
            eq(channelMessages.channelId, channelId),
            message.threadId
              ? eq(channelMessages.threadId, message.threadId)
              : isNull(channelMessages.threadId),
            lte(channelMessages.sequence, message.sequence),
            ne(channelMessages.id, messageId),
          ),
        )
        .orderBy(desc(channelMessages.sequence))
        .limit(CHANNEL_LIMITS.routerMessages),
    ]);
    return {
      message,
      members: members.filter((member) =>
        message.mentions.length
          ? message.mentions.includes(member.id)
          : !thread || thread.followerMemberIds.includes(member.id),
      ),
      recent: recent.reverse(),
    };
  }

  async assign(
    channelId: string,
    messageId: string,
    decision: {
      memberId?: string;
      memberIds?: string[];
      reason: string;
      diagnostics?: Record<string, unknown>;
    },
  ) {
    return this.db.transaction(async (tx) => {
      await this.owned(tx, channelId, true);
      const [message] = await tx
        .select()
        .from(channelMessages)
        .where(and(eq(channelMessages.channelId, channelId), eq(channelMessages.id, messageId)));
      if (!message || message.routingStatus !== 'pending') return false;
      const thread = await this.scope(tx, channelId, message.threadId);
      const audience = (
        decision.memberIds || (decision.memberId ? [decision.memberId] : [])
      ).filter((memberId) => !thread || thread.followerMemberIds.includes(memberId));
      if (audience.length) await this.deliver(tx, message, audience);
      await tx
        .update(channelMessages)
        .set({
          routingStatus: audience.length ? 'assigned' : 'unassigned',
          routingReason: decision.reason,
        })
        .where(eq(channelMessages.id, messageId));
      await tx
        .update(channelOutbox)
        .set({ processed: true })
        .where(
          and(
            eq(channelOutbox.channelId, channelId),
            eq(channelOutbox.kind, 'route'),
            eq(channelOutbox.targetId, messageId),
          ),
        );
      await this.audit(tx, channelId, 'routing_decided', messageId, decision);
      return true;
    });
  }

  async retryRouting(channelId: string, messageId: string) {
    await this.db.transaction(async (tx) => {
      await this.owned(tx, channelId, true);
      const [message] = await tx
        .update(channelMessages)
        .set({ routingStatus: 'pending', routingReason: null })
        .where(
          and(
            eq(channelMessages.channelId, channelId),
            eq(channelMessages.id, messageId),
            eq(channelMessages.routingStatus, 'unassigned'),
          ),
        )
        .returning();
      if (message) await this.outbox(tx, channelId, 'route', messageId);
    });
  }

  async branch(channelId: string, rootMessageId: string) {
    return this.db.transaction(async (tx) => {
      await this.owned(tx, channelId, true);
      const [root] = await tx
        .select()
        .from(channelMessages)
        .where(
          and(eq(channelMessages.channelId, channelId), eq(channelMessages.id, rootMessageId)),
        );
      if (!root || root.threadId)
        throw new ChannelError('BAD_REQUEST', 'A Thread must start from a main-stream message');
      const [existing] = await tx
        .select()
        .from(channelThreads)
        .where(
          and(
            eq(channelThreads.channelId, channelId),
            eq(channelThreads.rootMessageId, rootMessageId),
          ),
        );
      if (existing) return existing;
      const [thread] = await tx
        .insert(channelThreads)
        .values({
          id: id('thread'),
          channelId,
          rootMessageId,
          rootSequence: root.sequence,
          followerMemberIds: root.authorMemberId ? [root.authorMemberId] : root.mentions,
        })
        .returning();
      await this.audit(tx, channelId, 'thread_created', thread.id, {
        rootMessageId,
        cutoff: root.sequence,
      });
      return thread;
    });
  }

  async removeThreadFollower(channelId: string, threadId: string, memberId: string) {
    await this.db.transaction(async (tx) => {
      await this.owned(tx, channelId, true);
      const thread = (await this.scope(tx, channelId, threadId))!;
      if (!thread.followerMemberIds.includes(memberId)) return;
      await tx
        .update(channelThreads)
        .set({ followerMemberIds: thread.followerMemberIds.filter((id) => id !== memberId) })
        .where(eq(channelThreads.id, threadId));
      const jobs = await tx
        .select()
        .from(channelJobs)
        .where(
          and(
            eq(channelJobs.channelId, channelId),
            eq(channelJobs.threadId, threadId),
            eq(channelJobs.memberId, memberId),
          ),
        );
      if (jobs.length) {
        const jobIds = jobs.map((job) => job.id);
        await tx
          .update(channelJobs)
          .set({ status: 'cancelled' })
          .where(
            and(
              inArray(channelJobs.id, jobIds),
              inArray(channelJobs.status, ['queued', 'running']),
            ),
          );
        const runs = await tx.select().from(channelRuns).where(inArray(channelRuns.jobId, jobIds));
        for (const run of runs.filter(
          (run) => !run.publicationRevoked && (!run.publishedMessageId || !run.writerReleased),
        )) {
          await tx
            .update(channelRuns)
            .set({
              publicationRevoked: true,
              status: run.writerReleased ? 'stopped' : 'stop_requested',
            })
            .where(eq(channelRuns.id, run.id));
          if (!run.writerReleased) await this.outbox(tx, channelId, 'stop', run.id);
        }
      }
      await this.audit(tx, channelId, 'thread_follower_removed', threadId, { memberId });
    });
  }

  async unavailable(channelId: string, jobId: string, reason: string | null) {
    await this.db.transaction(async (tx) => {
      await this.owned(tx, channelId, true);
      const [job] = await tx
        .select()
        .from(channelJobs)
        .where(
          and(
            eq(channelJobs.channelId, channelId),
            eq(channelJobs.id, jobId),
            eq(channelJobs.status, 'queued'),
          ),
        );
      if (!job) return;
      if (job.blockedReason === reason) return;
      await tx.update(channelJobs).set({ blockedReason: reason }).where(eq(channelJobs.id, jobId));
      await this.audit(tx, channelId, 'job_unavailable', jobId, { reason });
    });
  }

  /** Called after adapter readiness and canonical workspace identity have been established. */
  async claim(channelId: string, jobId: string, expectedRevision?: number) {
    return this.db.transaction(async (tx) => {
      const channel = await this.owned(tx, channelId, true);
      const [job] = await tx
        .select()
        .from(channelJobs)
        .where(
          and(
            eq(channelJobs.channelId, channelId),
            eq(channelJobs.id, jobId),
            eq(channelJobs.status, 'queued'),
          ),
        );
      if (!job) return null;
      const [discussion] = job.discussionId
        ? await tx
            .select()
            .from(channelDiscussions)
            .where(eq(channelDiscussions.id, job.discussionId))
        : [];
      // Round pacing needs no claim-time gate: advanceDiscussions queues the next round only once
      // every participant's turn in the current round has settled, so a stale round job never
      // exists. Turns within a round remain concurrent; there is no prescribed speaking order.
      if (
        discussion &&
        (job.task?.kind === 'summarize'
          ? discussion.status !== 'summarizing'
          : discussion.status !== 'active')
      ) {
        await tx.update(channelJobs).set({ status: 'cancelled' }).where(eq(channelJobs.id, job.id));
        return null;
      }
      const [head] = await tx
        .select({ id: channelJobs.id })
        .from(channelJobs)
        .innerJoin(channelMessages, eq(channelJobs.messageId, channelMessages.id))
        .where(and(eq(channelJobs.memberId, job.memberId), eq(channelJobs.status, 'queued')))
        .orderBy(asc(channelMessages.sequence), asc(channelJobs.createdAt))
        .limit(1);
      if (head?.id !== job.id) return null;
      const [member] = await this.targets(tx, channelId, [job.memberId]);
      if (
        member.executionPaused ||
        (expectedRevision !== undefined && member.environmentRevision !== expectedRevision)
      )
        return null;
      const [busy] = await tx
        .select({ id: channelRuns.id })
        .from(channelRuns)
        .where(
          and(
            eq(channelRuns.memberId, member.id),
            or(
              eq(channelRuns.writerReleased, false),
              and(eq(channelRuns.cleanupRequested, true), eq(channelRuns.physicalStopped, false)),
            ),
          ),
        );
      if (busy) return null;
      const { deviceId, workingDirectory } = member.config;
      const [request] = await tx
        .select()
        .from(channelMessages)
        .where(eq(channelMessages.id, job.messageId));
      if (workingDirectory && !deviceId)
        throw new ChannelError('BAD_REQUEST', 'Workspace access requires a device');
      // Different Agents may use the same directory, just as when run independently.
      // The member check above serializes delivery into each native session only.
      const scope = job.threadId || 'main';
      const thread = await this.scope(tx, channelId, job.threadId);
      const [session] = await tx
        .insert(channelSessions)
        .values({ id: id('session'), channelId, memberId: member.id, scope })
        .onConflictDoUpdate({
          target: [channelSessions.memberId, channelSessions.scope],
          set: { scope },
        })
        .returning();
      const [previous] = job.task?.previousRunId
        ? await tx.select().from(channelRuns).where(eq(channelRuns.id, job.task.previousRunId))
        : [];
      if (
        previous &&
        (previous.environmentRevision !== member.environmentRevision ||
          previous.sessionId !== session.id ||
          previous.manifest.sessionGeneration !== session.generation ||
          !session.nativeSessionId)
      ) {
        await tx
          .update(channelJobs)
          .set({ status: 'cancelled', blockedReason: 'Held draft session changed' })
          .where(eq(channelJobs.id, job.id));
        return null;
      }
      const cutoffSequence = discussion ? channel.sequence : request.sequence;
      const visible = await tx
        .select()
        .from(channelMessages)
        .where(
          and(
            eq(channelMessages.channelId, channelId),
            lte(channelMessages.sequence, cutoffSequence),
            thread
              ? or(
                  eq(channelMessages.threadId, thread.id),
                  and(
                    isNull(channelMessages.threadId),
                    lte(channelMessages.sequence, thread.rootSequence),
                  ),
                )
              : isNull(channelMessages.threadId),
          ),
        )
        .orderBy(asc(channelMessages.sequence));
      const roster = await tx
        .select()
        .from(channelMembers)
        .where(eq(channelMembers.channelId, channelId));
      const accepted = new Set(session.nativeSessionId ? session.acceptedMessageIds : []);
      const manifest: ChannelInputManifest = {
        cutoffSequence,
        requestMessageId: job.messageId,
        ...(discussion && {
          discussion: {
            id: discussion.id,
            kind: job.task?.kind || 'discuss',
            maxRounds: discussion.maxRounds,
            participants: roster
              .filter((member) => discussion.participantIds.includes(member.id))
              .map((member) => ({ memberId: member.id, name: member.name })),
            round: discussion.round,
            ...(previous?.draft && { heldDraft: previous.draft }),
          },
        }),
        self: { memberId: member.id, name: member.name },
        sessionGeneration: session.generation,
        source: session.nativeSessionId ? 'incremental' : 'reconstructed',
        threadId: job.threadId,
        threadRootSequence: thread?.rootSequence ?? null,
        messages: visible
          .filter((m) => !accepted.has(m.id))
          .map((m) => ({
            id: m.id,
            sequence: m.sequence,
            threadId: m.threadId,
            content: m.content,
            ...(m.fileIds.length && { fileIds: m.fileIds }),
            author: m.authorMemberId
              ? {
                  id: m.authorMemberId,
                  name: roster.find((r) => r.id === m.authorMemberId)?.name || 'Removed member',
                  type: 'member',
                }
              : { id: this.ownerId, name: 'Owner', type: 'human' },
          })),
      };
      const [run] = await tx
        .insert(channelRuns)
        .values({
          id: id('run'),
          channelId,
          jobId,
          memberId: member.id,
          sessionId: session.id,
          executionConfig: member.config,
          environmentRevision: member.environmentRevision,
          manifest,
        })
        .returning();
      await tx.update(channelJobs).set({ status: 'running' }).where(eq(channelJobs.id, job.id));
      await this.audit(tx, channelId, 'run_claimed', run.id, {
        jobId,
        cutoff: manifest.cutoffSequence,
      });
      return { run, member, session };
    });
  }

  async advanceDiscussions(channelId: string) {
    await this.db.transaction(async (tx) => {
      await this.owned(tx, channelId, true);
      await advanceDiscussions(tx, channelId);
    });
  }

  /** Pause and claim serialize on the same Channel row; queued messages remain durable. */
  async pauseMember(
    channelId: string,
    memberId: string,
    expectedRevision: number,
    onlyIfIdle = false,
  ) {
    return this.db.transaction(async (tx) => {
      await this.owned(tx, channelId, true);
      const [member] = await this.targets(tx, channelId, [memberId]);
      if (member.environmentRevision !== expectedRevision)
        throw new ChannelError('CONFLICT', 'Member environment changed; reload before editing');
      if (member.config.runtime === 'native')
        throw new ChannelError('BAD_REQUEST', 'Native local execution is not supported yet');
      const runs = await tx.select().from(channelRuns).where(eq(channelRuns.memberId, memberId));
      if (onlyIfIdle) {
        const [job] = await tx
          .select({ id: channelJobs.id })
          .from(channelJobs)
          .where(
            and(
              eq(channelJobs.memberId, memberId),
              inArray(channelJobs.status, ['queued', 'running']),
            ),
          )
          .limit(1);
        if (job || runs.some((run) => !run.physicalStopped || !run.writerReleased))
          return { confirmationRequired: true };
      }
      if (member.executionPaused) return { confirmationRequired: false };
      await tx
        .update(channelMembers)
        .set({ executionPaused: true })
        .where(eq(channelMembers.id, memberId));
      for (const run of runs) {
        const revoke = !run.writerReleased || !run.publishedMessageId;
        await tx
          .update(channelRuns)
          .set({
            cleanupRequested: !run.physicalStopped,
            ...(revoke && {
              publicationRevoked: true,
              status: run.writerReleased ? run.status : 'stop_requested',
            }),
          })
          .where(eq(channelRuns.id, run.id));
      }
      await tx
        .update(channelJobs)
        .set({ status: 'cancelled' })
        .where(and(eq(channelJobs.memberId, memberId), eq(channelJobs.status, 'running')));
      await this.audit(tx, channelId, 'member_execution_paused', memberId);
      return { confirmationRequired: false };
    });
  }

  async resumeMember(channelId: string, memberId: string, expectedRevision: number) {
    await this.db.transaction(async (tx) => {
      await this.owned(tx, channelId, true);
      const [member] = await this.targets(tx, channelId, [memberId]);
      if (member.environmentRevision !== expectedRevision)
        throw new ChannelError('CONFLICT', 'Member environment changed; reload before editing');
      if (!member.executionPaused) return;
      // Cleanup requests stay durable even if the user cancels switching.
      await tx
        .update(channelMembers)
        .set({ executionPaused: false })
        .where(eq(channelMembers.id, memberId));
      await this.audit(tx, channelId, 'member_execution_resumed', memberId);
    });
  }

  async updateEnvironment(
    channelId: string,
    memberId: string,
    expectedRevision: number,
    environment: { deviceId: string; workingDirectory: string },
  ) {
    await this.db.transaction(async (tx) => {
      const channel = await this.owned(tx, channelId, true);
      const [member] = await this.targets(tx, channelId, [memberId]);
      if (member.environmentRevision !== expectedRevision || !member.executionPaused)
        throw new ChannelError('CONFLICT', 'Pause the current member environment before switching');
      if (member.config.runtime === 'native')
        throw new ChannelError('BAD_REQUEST', 'Native local execution is not supported yet');
      const [busy] = await tx
        .select({ id: channelRuns.id })
        .from(channelRuns)
        .where(
          and(
            eq(channelRuns.memberId, memberId),
            or(eq(channelRuns.writerReleased, false), eq(channelRuns.physicalStopped, false)),
          ),
        );
      if (busy) throw new ChannelError('CONFLICT', 'Old execution has not been confirmed stopped');
      if (
        member.config.deviceId === environment.deviceId &&
        member.config.workingDirectory === environment.workingDirectory
      ) {
        await tx
          .update(channelMembers)
          .set({ executionPaused: false })
          .where(eq(channelMembers.id, memberId));
        return;
      }
      await tx
        .update(channelJobs)
        .set({ status: 'cancelled', blockedReason: 'Member execution environment changed' })
        .where(and(eq(channelJobs.memberId, memberId), eq(channelJobs.status, 'queued')));
      const sessions = await tx
        .select()
        .from(channelSessions)
        .where(eq(channelSessions.memberId, memberId));
      for (const session of sessions.filter((s) => !s.scope.startsWith('archived:'))) {
        await tx
          .update(channelSessions)
          .set({ scope: `archived:${session.id}` })
          .where(eq(channelSessions.id, session.id));
        await tx.insert(channelSessions).values({
          id: id('session'),
          channelId,
          memberId,
          scope: session.scope,
          generation: session.generation + 1,
        });
      }
      await tx
        .update(channelMembers)
        .set({
          config: { ...member.config, ...environment },
          environmentRevision: member.environmentRevision + 1,
          environmentCutoff: channel.sequence,
          executionPaused: false,
        })
        .where(eq(channelMembers.id, memberId));
      await this.audit(tx, channelId, 'member_environment_changed', memberId, {
        ...environment,
        revision: member.environmentRevision + 1,
      });
    });
  }

  /** Only the worker may record a device's physical termination acknowledgement. */
  async recordEnvironmentCleanup(
    channelId: string,
    runId: string,
    fence: number,
    stopped: boolean,
    error?: string,
  ) {
    await this.db.transaction(async (tx) => {
      const run = await this.fenced(tx, channelId, runId, fence, true);
      if (run.physicalStopped) return;
      await tx
        .update(channelRuns)
        .set({
          physicalStopped: stopped,
          ...(stopped && { cleanupRequested: false }),
          environmentError: stopped
            ? null
            : error || 'Old execution has not been confirmed stopped',
        })
        .where(eq(channelRuns.id, runId));
      if (stopped) await this.audit(tx, channelId, 'execution_physically_stopped', runId);
    });
  }

  async resetSession(channelId: string, memberId: string, threadId: string | null) {
    await this.db.transaction(async (tx) => {
      await this.owned(tx, channelId, true);
      await this.targets(tx, channelId, [memberId]);
      await this.scope(tx, channelId, threadId);
      const [active] = await tx
        .select()
        .from(channelRuns)
        .where(and(eq(channelRuns.memberId, memberId), eq(channelRuns.writerReleased, false)));
      if (active)
        throw new ChannelError(
          'CONFLICT',
          'Confirm execution has ended before rebuilding a session',
        );
      const scope = threadId || 'main';
      const [current] = await tx
        .select()
        .from(channelSessions)
        .where(and(eq(channelSessions.memberId, memberId), eq(channelSessions.scope, scope)));
      if (!current) return;
      await tx
        .update(channelSessions)
        .set({ scope: `archived:${current.id}` })
        .where(eq(channelSessions.id, current.id));
      await tx.insert(channelSessions).values({
        id: id('session'),
        channelId,
        memberId,
        scope,
        generation: current.generation + 1,
      });
      await this.audit(tx, channelId, 'session_rebuilt', memberId, {
        scope,
        generation: current.generation + 1,
      });
    });
  }

  async setActivity(channelId: string, runId: string, fence: number, state: 'running' | 'typing') {
    await this.db.transaction(async (tx) => {
      const run = await this.fenced(tx, channelId, runId, fence);
      if (run.writerReleased || !['starting', 'running'].includes(run.status)) return;
      if (run.activity === state && run.status !== 'starting') return;
      await tx
        .update(channelRuns)
        .set({ activity: state, status: 'running' })
        .where(eq(channelRuns.id, runId));
      await this.audit(tx, channelId, 'run_activity', runId, { state });
    });
  }

  private async fenced(
    tx: Transaction,
    channelId: string,
    runId: string,
    fence: number,
    allowRevoked = false,
  ) {
    await this.owned(tx, channelId);
    // Lock even archived Channels when recording physical termination.
    await tx
      .select({ id: channels.id })
      .from(channels)
      .where(eq(channels.id, channelId))
      .for('update');
    const [run] = await tx
      .select()
      .from(channelRuns)
      .where(
        and(
          eq(channelRuns.channelId, channelId),
          eq(channelRuns.id, runId),
          eq(channelRuns.fence, fence),
        ),
      );
    if (!run || (!allowRevoked && run.publicationRevoked))
      throw new ChannelError('CONFLICT', 'Run authority was revoked');
    return run;
  }

  async accepted(
    channelId: string,
    runId: string,
    fence: number,
    nativeSessionId: string,
    nativeTurnId: string,
  ) {
    await this.db.transaction(async (tx) => {
      const run = await this.fenced(tx, channelId, runId, fence);
      if (run.acceptance === 'accepted') return;
      await tx
        .update(channelRuns)
        .set({ acceptance: 'accepted', status: 'running', nativeTurnId })
        .where(eq(channelRuns.id, runId));
      const [session] = await tx
        .select()
        .from(channelSessions)
        .where(eq(channelSessions.id, run.sessionId));
      await tx
        .update(channelSessions)
        .set({
          nativeSessionId,
          acceptedMessageIds: [
            ...new Set([...session.acceptedMessageIds, ...run.manifest.messages.map((m) => m.id)]),
          ],
        })
        .where(eq(channelSessions.id, session.id));
      await this.audit(tx, channelId, 'input_accepted', runId, { nativeTurnId });
    });
  }

  async saveDraft(channelId: string, runId: string, fence: number, content: string) {
    await this.db.transaction(async (tx) => {
      const run = await this.fenced(tx, channelId, runId, fence);
      if (run.draft !== null) {
        if (run.draft !== content) throw new ChannelError('CONFLICT', 'Final draft is immutable');
        return;
      }
      await tx.update(channelRuns).set({ draft: content }).where(eq(channelRuns.id, runId));
      await this.outbox(tx, channelId, 'publish', runId);
    });
  }

  /** Only a physically terminated writer can hand its saved draft to a new publisher. */
  async recoverDraft(channelId: string, runId: string, previousFence: number) {
    return this.db.transaction(async (tx) => {
      const run = await this.fenced(tx, channelId, runId, previousFence);
      if (!run.writerReleased || run.draft === null || run.publishedMessageId)
        throw new ChannelError('CONFLICT', 'Draft is not eligible for recovery');
      const fence = run.fence + 1;
      await tx.update(channelRuns).set({ fence }).where(eq(channelRuns.id, run.id));
      await this.audit(tx, channelId, 'publisher_recovered', run.id, { previousFence, fence });
      return fence;
    });
  }

  async recordExecution(
    channelId: string,
    runId: string,
    fence: number,
    details: Record<string, unknown>,
  ) {
    await this.db.transaction(async (tx) => {
      await this.fenced(tx, channelId, runId, fence);
      await tx
        .insert(channelAudit)
        .values({
          id: `chn_metrics_${runId}`,
          channelId,
          targetId: runId,
          event: 'execution_metrics',
          details,
        })
        .onConflictDoNothing();
    });
  }

  async publish(channelId: string, runId: string, fence: number) {
    return this.db.transaction(async (tx) => {
      const channel = await this.owned(tx, channelId, true);
      const run = await this.fenced(tx, channelId, runId, fence);
      if (run.publishedMessageId) return run.publishedMessageId;
      if (run.publicationStatus !== 'pending') return null;
      if (run.draft === null || run.acceptance !== 'accepted')
        throw new ChannelError('CONFLICT', 'No accepted final draft');
      await this.targets(tx, channelId, [run.memberId]);
      const [discussion] = run.manifest.discussion
        ? await tx
            .select()
            .from(channelDiscussions)
            .where(eq(channelDiscussions.id, run.manifest.discussion.id))
        : [];
      if (discussion) {
        const summarizing = run.manifest.discussion!.kind === 'summarize';
        const live = discussion.status === (summarizing ? 'summarizing' : 'active');
        // Checking freshness and inserting the candidate share this Channel lock.
        // Input dedup cursors never confer authority on an older immutable candidate.
        const [newer] = await tx
          .select({ id: channelMessages.id })
          .from(channelMessages)
          .where(
            and(
              eq(channelMessages.channelId, channelId),
              gt(channelMessages.sequence, run.manifest.cutoffSequence),
              run.manifest.threadId
                ? eq(channelMessages.threadId, run.manifest.threadId)
                : isNull(channelMessages.threadId),
            ),
          )
          .limit(1);
        const yielded = !summarizing && run.draft.trim() === '[[CHANNEL_YIELD]]';
        // A candidate may only publish in the round it was claimed for. The round cannot advance
        // while its writer is live, so this only catches publication after release.
        const stale = !summarizing && run.manifest.discussion!.round !== discussion.round;
        if (!live || newer || yielded || stale) {
          const publicationStatus = !live || newer || stale ? 'held' : 'yielded';
          await tx.update(channelRuns).set({ publicationStatus }).where(eq(channelRuns.id, run.id));
          await tx
            .update(channelJobs)
            .set({ status: 'completed' })
            .where(eq(channelJobs.id, run.jobId));
          // A revision keeps this member's turn open within the same round.
          if (live && newer && !summarizing && !stale)
            await queueDiscussionTurn(tx, discussion, run.memberId, `held:${run.id}`, {
              kind: 'revise',
              previousRunId: run.id,
              round: discussion.round,
            });
          await this.audit(tx, channelId, `draft_${publicationStatus}`, run.id, {
            cutoff: run.manifest.cutoffSequence,
            newerMessageId: newer?.id,
          });
          return null;
        }
      }
      const messageId = id('msg');
      await tx.insert(channelMessages).values({
        id: messageId,
        channelId,
        threadId: run.manifest.threadId,
        sequence: channel.sequence + 1,
        authorMemberId: run.memberId,
        content: run.draft,
        requestKey: `run:${run.id}`,
        replyToId: run.manifest.requestMessageId,
        routingStatus: 'reply',
      });
      await tx
        .update(channels)
        .set({ sequence: channel.sequence + 1 })
        .where(eq(channels.id, channelId));
      await tx
        .update(channelRuns)
        .set({ publishedMessageId: messageId, publicationStatus: 'published' })
        .where(eq(channelRuns.id, runId));
      await tx
        .update(channelJobs)
        .set({ status: 'completed' })
        .where(eq(channelJobs.id, run.jobId));
      // A final answer is only a candidate until published. Deliver its attributed public record
      // back to the author once, too: native output alone cannot confirm which draft was published.
      // Only accepted() advances the input receipt, so later deltas still avoid replaying history.
      await this.audit(tx, channelId, 'draft_published', runId, { messageId });
      if (discussion) {
        if (run.manifest.discussion!.kind === 'summarize') {
          await tx
            .update(channelDiscussions)
            .set({ status: 'completed', summaryMessageId: messageId })
            .where(eq(channelDiscussions.id, discussion.id));
        } else {
          // Peers are not woken here: they answer in the next round, which advanceDiscussions
          // opens once every turn of this round has settled. Slower peers still drafting in
          // this round are held and revise against this message.
          await tx
            .update(channelDiscussions)
            .set({ turnsPublished: discussion.turnsPublished + 1 })
            .where(eq(channelDiscussions.id, discussion.id));
        }
      }
      return messageId;
    });
  }

  async stop(channelId: string, scope: { runId: string } | { threadId: string | null }) {
    await this.db.transaction(async (tx) => {
      await this.owned(tx, channelId, true, true);
      if ('threadId' in scope) {
        await this.scope(tx, channelId, scope.threadId);
        await stopDiscussions(tx, channelId, scope.threadId, 'stopped');
        await tx
          .update(channelMessages)
          .set({ routingStatus: 'unassigned', routingReason: 'Stopped before assignment' })
          .where(
            and(
              eq(channelMessages.channelId, channelId),
              eq(channelMessages.routingStatus, 'pending'),
              scope.threadId
                ? eq(channelMessages.threadId, scope.threadId)
                : isNull(channelMessages.threadId),
            ),
          );
      }
      const jobs = await tx
        .select()
        .from(channelJobs)
        .where(
          and(
            eq(channelJobs.channelId, channelId),
            'threadId' in scope
              ? scope.threadId
                ? eq(channelJobs.threadId, scope.threadId)
                : isNull(channelJobs.threadId)
              : undefined,
          ),
        );
      const runs = await tx
        .select()
        .from(channelRuns)
        .where(
          and(
            eq(channelRuns.channelId, channelId),
            'runId' in scope
              ? eq(channelRuns.id, scope.runId)
              : inArray(
                  channelRuns.jobId,
                  jobs.map((j) => j.id),
                ),
          ),
        );
      const jobIds = 'runId' in scope ? runs.map((r) => r.jobId) : jobs.map((j) => j.id);
      if (jobIds.length)
        await tx
          .update(channelJobs)
          .set({ status: 'cancelled' })
          .where(
            and(
              inArray(channelJobs.id, jobIds),
              inArray(channelJobs.status, ['queued', 'running']),
            ),
          );
      const cancellable = runs.filter(
        (run) => !run.publicationRevoked && (!run.publishedMessageId || !run.writerReleased),
      );
      for (const run of cancellable) {
        await tx
          .update(channelRuns)
          .set({
            publicationRevoked: true,
            status: run.writerReleased ? 'stopped' : 'stop_requested',
          })
          .where(eq(channelRuns.id, run.id));
        if (!run.writerReleased) await this.outbox(tx, channelId, 'stop', run.id);
      }
      if (
        cancellable.length ||
        jobs.some((job) => jobIds.includes(job.id) && ['queued', 'running'].includes(job.status))
      )
        await this.audit(tx, channelId, 'stop_requested', channelId, scope);
    });
  }

  /** Invoked by a trusted adapter's physical termination observation, never by the UI. */
  async fail(
    channelId: string,
    runId: string,
    fence: number,
    message: string,
    executionUnknown = false,
    /** Trusted pre-dispatch failure: revoke and release atomically, even across worker restart. */
    notSubmitted = false,
  ) {
    await this.db.transaction(async (tx) => {
      const run = await this.fenced(tx, channelId, runId, fence, true);
      const [job] = await tx
        .select({ status: channelJobs.status })
        .from(channelJobs)
        .where(eq(channelJobs.id, run.jobId));
      const cancelled =
        job?.status === 'cancelled' || ['stop_requested', 'stopped'].includes(run.status);
      await tx
        .update(channelRuns)
        .set({
          error: cancelled ? null : message,
          status: cancelled
            ? run.writerReleased
              ? 'stopped'
              : 'stop_requested'
            : executionUnknown
              ? 'execution_unknown'
              : 'failed',
          publicationRevoked: true,
          ...(notSubmitted && {
            writerReleased: true,
            physicalStopped: true,
            cleanupRequested: false,
            environmentError: null,
          }),
        })
        .where(eq(channelRuns.id, run.id));
      if (!cancelled)
        await tx.update(channelJobs).set({ status: 'failed' }).where(eq(channelJobs.id, run.jobId));
      await this.audit(tx, channelId, 'execution_failed', run.id, {
        message,
        executionUnknown,
        notSubmitted,
      });
    });
  }

  /** Loss of an acknowledgement is not permission to revoke or repeat a native turn. */
  async executionUnknown(channelId: string, runId: string, fence: number, message: string) {
    await this.db.transaction(async (tx) => {
      const run = await this.fenced(tx, channelId, runId, fence, true);
      if (run.writerReleased || run.status === 'execution_unknown') return;
      await tx
        .update(channelRuns)
        .set({ status: 'execution_unknown', error: message })
        .where(eq(channelRuns.id, runId));
      await this.audit(tx, channelId, 'execution_unknown', runId, { message });
    });
  }

  async requestApproval(
    channelId: string,
    runId: string,
    fence: number,
    approvalId: string,
    request: Record<string, unknown>,
    expiresAt: Date,
  ) {
    // Polling an existing checkpoint is read-only; creation/expiry still serialize with revocation.
    const [existing] = await this.db
      .select({ approval: channelApprovals })
      .from(channelApprovals)
      .innerJoin(channelRuns, eq(channelRuns.id, channelApprovals.runId))
      .innerJoin(channels, eq(channels.id, channelRuns.channelId))
      .where(
        and(
          eq(channels.ownerId, this.ownerId),
          eq(channels.id, channelId),
          eq(channelRuns.id, runId),
          eq(channelRuns.fence, fence),
          eq(channelRuns.publicationRevoked, false),
          eq(channelRuns.writerReleased, false),
          eq(channelApprovals.id, approvalId),
        ),
      );
    if (
      existing &&
      (existing.approval.decision || existing.approval.expiresAt.getTime() > Date.now())
    )
      return existing.approval;
    return this.db.transaction(async (tx) => {
      const run = await this.fenced(tx, channelId, runId, fence);
      const [approval] = await tx
        .insert(channelApprovals)
        .values({ id: approvalId, runId, request, expiresAt })
        .onConflictDoUpdate({ target: channelApprovals.id, set: { id: approvalId } })
        .returning();
      if (approval.runId !== run.id)
        throw new ChannelError('CONFLICT', 'Approval belongs to another Run');
      if (!approval.decision && approval.expiresAt.getTime() <= Date.now()) {
        await tx
          .update(channelApprovals)
          .set({ decision: 'expired' })
          .where(eq(channelApprovals.id, approvalId));
        await tx
          .update(channelRuns)
          .set({ publicationRevoked: true, status: 'stop_requested' })
          .where(eq(channelRuns.id, runId));
        await tx
          .update(channelJobs)
          .set({ status: 'cancelled' })
          .where(eq(channelJobs.id, run.jobId));
        await this.outbox(tx, channelId, 'stop', runId);
        await this.audit(tx, channelId, 'approval_expired', approvalId);
        return { ...approval, decision: 'expired' as const };
      }
      if (!approval.decision)
        await tx
          .update(channelRuns)
          .set({ status: 'awaiting_approval' })
          .where(eq(channelRuns.id, runId));
      return approval;
    });
  }

  async decideApproval(channelId: string, approvalId: string, approved: boolean) {
    await this.db.transaction(async (tx) => {
      await this.owned(tx, channelId, true);
      const [entry] = await tx
        .select({ approval: channelApprovals, run: channelRuns })
        .from(channelApprovals)
        .innerJoin(channelRuns, eq(channelRuns.id, channelApprovals.runId))
        .where(and(eq(channelRuns.channelId, channelId), eq(channelApprovals.id, approvalId)));
      if (!entry || entry.run.publicationRevoked || entry.run.writerReleased)
        throw new ChannelError('CONFLICT', 'Approval is no longer active');
      if (entry.approval.decision) {
        if (entry.approval.decision === (approved ? 'approved' : 'rejected')) return;
        throw new ChannelError('CONFLICT', 'Approval was already decided');
      }
      if (entry.approval.expiresAt.getTime() <= Date.now())
        throw new ChannelError('CONFLICT', 'Approval expired');
      await tx
        .update(channelApprovals)
        .set({ decision: approved ? 'approved' : 'rejected' })
        .where(eq(channelApprovals.id, approvalId));
      await this.audit(tx, channelId, 'approval_decided', approvalId, { approved });
    });
  }

  async resumeAfterApproval(channelId: string, runId: string, fence: number) {
    await this.db.transaction(async (tx) => {
      await this.fenced(tx, channelId, runId, fence);
      await tx.update(channelRuns).set({ status: 'running' }).where(eq(channelRuns.id, runId));
    });
  }

  async releaseWriter(channelId: string, runId: string, fence: number) {
    await this.db.transaction(async (tx) => {
      const run = await this.fenced(tx, channelId, runId, fence, true);
      if (run.writerReleased) return;
      await tx
        .update(channelRuns)
        .set({
          writerReleased: true,
          ...(run.executionConfig?.runtime === 'native' && {
            physicalStopped: true,
            cleanupRequested: false,
          }),
          error: run.status === 'failed' ? run.error : null,
          status:
            run.status === 'failed' ? 'failed' : run.publicationRevoked ? 'stopped' : 'completed',
        })
        .where(eq(channelRuns.id, run.id));
      await this.audit(tx, channelId, 'writer_terminated', run.id);
    });
  }
}

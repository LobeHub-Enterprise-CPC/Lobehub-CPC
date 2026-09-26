import { randomUUID } from 'node:crypto';

import type { ChannelInputManifest, ChannelMemberConfig } from '@lobechat/types';
import { CHANNEL_LIMITS } from '@lobechat/types';
import { and, asc, desc, eq, inArray, isNull, lte, ne, or } from 'drizzle-orm';

import {
  channelApprovals,
  channelAudit,
  channelJobs,
  channelMembers,
  channelMessages,
  channelOutbox,
  channelRuns,
  channels,
  channelSessions,
  channelThreads,
  channelWorkspaceLocks,
} from '../schemas/channel';
import type { LobeChatDatabase, Transaction } from '../type';

type DB = LobeChatDatabase | Transaction;
const id = (kind: string) => `chn_${kind}_${randomUUID()}`;
class WorkspaceBusy extends Error {}

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
      .where(eq(channels.ownerId, this.ownerId))
      .orderBy(desc(channels.createdAt));

  async create(
    title: string,
    members: { name: string; description?: string; config: ChannelMemberConfig }[],
  ) {
    if (!title.trim() || !members.length || members.length > CHANNEL_LIMITS.members)
      throw new ChannelError('BAD_REQUEST', 'A Channel requires a title and one to four members');
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
          acceptance: channelRuns.acceptance,
          publicationRevoked: channelRuns.publicationRevoked,
          writerReleased: channelRuns.writerReleased,
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
    const blocks = await this.db
      .select()
      .from(channelAudit)
      .where(and(eq(channelAudit.channelId, channelId), eq(channelAudit.event, 'job_unavailable')))
      .orderBy(desc(channelAudit.createdAt));
    const activity = await this.db
      .select()
      .from(channelAudit)
      .where(and(eq(channelAudit.channelId, channelId), eq(channelAudit.event, 'run_activity')))
      .orderBy(desc(channelAudit.createdAt));
    return {
      channel,
      members,
      threads,
      messages,
      jobs: jobs.map((job) => ({
        ...job,
        blockedReason:
          job.status === 'queued'
            ? (blocks.find((entry) => entry.targetId === job.id)?.details.reason as
                string | undefined)
            : undefined,
      })),
      runs: runs.map((run) => ({
        ...run,
        activity: activity.find((entry) => entry.targetId === run.id)?.details.state as
          'running' | 'typing' | undefined,
      })),
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
        throw new ChannelError('BAD_REQUEST', 'A Channel supports at most four active members');
      const configs = [...active, ...members].map((member) => member.config);
      const agentIds = configs.map((config) => config.agentId).filter(Boolean);
      if (new Set(agentIds).size !== agentIds.length)
        throw new ChannelError('BAD_REQUEST', 'This Agent is already a member of the Channel');
      if (
        new Set(configs.map((config) => config.deviceId).filter(Boolean)).size > 1 ||
        new Set(configs.map((config) => config.workingDirectory).filter(Boolean)).size > 1
      )
        throw new ChannelError('BAD_REQUEST', 'A Channel uses one device and workspace');
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
      for (const run of runs.filter((run) => !run.writerReleased || !run.publishedMessageId)) {
        await tx
          .update(channelRuns)
          .set({
            publicationRevoked: true,
            status: run.writerReleased ? 'stopped' : 'stop_requested',
          })
          .where(eq(channelRuns.id, run.id));
        if (!run.writerReleased) await this.outbox(tx, channelId, 'stop', run.id);
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
    await this.targets(db, message.channelId, memberIds);
    for (const memberId of new Set(memberIds)) {
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
    input: { content: string; mentions: string[]; requestKey: string; threadId?: string | null },
  ) {
    if (!input.content.trim() || !input.requestKey || input.content.length > 100_000)
      throw new ChannelError(
        'BAD_REQUEST',
        'A message requires bounded content and a retry identity',
      );
    return this.db.transaction(async (tx) => {
      const channel = await this.owned(tx, channelId, true);
      await this.scope(tx, channelId, input.threadId);
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
        if (
          existing.content !== input.content ||
          existing.threadId !== (input.threadId || null) ||
          JSON.stringify(existing.mentions) !== JSON.stringify(mentions)
        )
          throw new ChannelError(
            'CONFLICT',
            'Retry identity was already used for a different message',
          );
        return existing;
      }
      await this.targets(tx, channelId, mentions);
      // Resolve the audience while holding the Channel lock, in the same transaction as send.
      // Availability affects execution, never whether a member receives a public request.
      const audience = mentions.length
        ? mentions
        : (
            await tx
              .select({ id: channelMembers.id })
              .from(channelMembers)
              .where(and(eq(channelMembers.channelId, channelId), eq(channelMembers.active, true)))
          ).map((member) => member.id);
      const [message] = await tx
        .insert(channelMessages)
        .values({
          id: id('msg'),
          channelId,
          threadId: input.threadId || null,
          sequence: channel.sequence + 1,
          content: input.content,
          mentions,
          requestKey: input.requestKey,
          routingStatus: mentions.length ? 'directed' : audience.length ? 'assigned' : 'unassigned',
          routingReason: mentions.length ? 'Mentioned members' : 'All active members',
        })
        .returning();
      await tx
        .update(channels)
        .set({ sequence: message.sequence })
        .where(eq(channels.id, channelId));
      await this.deliver(tx, message, audience);
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
    return { message, members, recent: recent.reverse() };
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
      const audience = decision.memberIds || (decision.memberId ? [decision.memberId] : []);
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
        .values({ id: id('thread'), channelId, rootMessageId, rootSequence: root.sequence })
        .returning();
      await this.audit(tx, channelId, 'thread_created', thread.id, {
        rootMessageId,
        cutoff: root.sequence,
      });
      return thread;
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
      const [previous] = await tx
        .select()
        .from(channelAudit)
        .where(
          and(
            eq(channelAudit.channelId, channelId),
            eq(channelAudit.event, 'job_unavailable'),
            eq(channelAudit.targetId, jobId),
          ),
        )
        .orderBy(desc(channelAudit.createdAt))
        .limit(1);
      if ((previous || reason !== null) && previous?.details.reason !== reason)
        await this.audit(tx, channelId, 'job_unavailable', jobId, { reason });
    });
  }

  /** Called after adapter readiness and canonical workspace identity have been established. */
  async claim(channelId: string, jobId: string) {
    return this.db
      .transaction(async (tx) => {
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
        if (!job) return null;
        const [head] = await tx
          .select({ id: channelJobs.id })
          .from(channelJobs)
          .innerJoin(channelMessages, eq(channelJobs.messageId, channelMessages.id))
          .where(and(eq(channelJobs.memberId, job.memberId), eq(channelJobs.status, 'queued')))
          .orderBy(asc(channelMessages.sequence), asc(channelJobs.createdAt))
          .limit(1);
        if (head?.id !== job.id) return null;
        const [member] = await this.targets(tx, channelId, [job.memberId]);
        const [busy] = await tx
          .select({ id: channelRuns.id })
          .from(channelRuns)
          .where(and(eq(channelRuns.memberId, member.id), eq(channelRuns.writerReleased, false)));
        if (busy) return null;
        const { deviceId, workingDirectory } = member.config;
        const [request] = await tx
          .select()
          .from(channelMessages)
          .where(eq(channelMessages.id, job.messageId));
        if (workingDirectory && !deviceId)
          throw new ChannelError('BAD_REQUEST', 'Workspace access requires a device');
        if (deviceId && workingDirectory) {
          const [lock] = await tx
            .select()
            .from(channelWorkspaceLocks)
            .where(
              and(
                eq(channelWorkspaceLocks.ownerId, this.ownerId),
                eq(channelWorkspaceLocks.deviceId, deviceId),
                eq(channelWorkspaceLocks.directory, workingDirectory),
              ),
            );
          if (lock) return null;
        }
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
        const visible = await tx
          .select()
          .from(channelMessages)
          .where(
            and(
              eq(channelMessages.channelId, channelId),
              lte(channelMessages.sequence, request.sequence),
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
          cutoffSequence: request.sequence,
          requestMessageId: job.messageId,
          sessionGeneration: session.generation,
          source: session.nativeSessionId ? 'incremental' : 'reconstructed',
          threadId: job.threadId,
          messages: visible
            .filter((m) => !accepted.has(m.id))
            .map((m) => ({
              id: m.id,
              sequence: m.sequence,
              threadId: m.threadId,
              content: m.content,
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
            manifest,
          })
          .returning();
        if (deviceId && workingDirectory) {
          const [lock] = await tx
            .insert(channelWorkspaceLocks)
            .values({
              id: id('lock'),
              ownerId: this.ownerId,
              deviceId,
              directory: workingDirectory,
              runId: run.id,
            })
            .onConflictDoNothing()
            .returning();
          // A competing Channel may acquire the same resource after our initial read.
          // Roll back this whole claim, including its Run, rather than leave a stranded writer.
          if (!lock) throw new WorkspaceBusy();
        }
        await tx.update(channelJobs).set({ status: 'running' }).where(eq(channelJobs.id, job.id));
        await this.audit(tx, channelId, 'run_claimed', run.id, {
          jobId,
          cutoff: manifest.cutoffSequence,
        });
        return { run, member, session };
      })
      .catch((error: unknown) => {
        if (error instanceof WorkspaceBusy) return null;
        throw error;
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
      const [previous] = await tx
        .select()
        .from(channelAudit)
        .where(and(eq(channelAudit.targetId, runId), eq(channelAudit.event, 'run_activity')))
        .orderBy(desc(channelAudit.createdAt))
        .limit(1);
      if (previous?.details.state !== state)
        await this.audit(tx, channelId, 'run_activity', runId, { state });
      if (run.status === 'starting')
        await tx.update(channelRuns).set({ status: 'running' }).where(eq(channelRuns.id, runId));
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
      if (run.draft === null || run.acceptance !== 'accepted')
        throw new ChannelError('CONFLICT', 'No accepted final draft');
      await this.targets(tx, channelId, [run.memberId]);
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
        .set({ publishedMessageId: messageId })
        .where(eq(channelRuns.id, runId));
      await tx
        .update(channelJobs)
        .set({ status: 'completed' })
        .where(eq(channelJobs.id, run.jobId));
      const [session] = await tx
        .select()
        .from(channelSessions)
        .where(eq(channelSessions.id, run.sessionId));
      await tx
        .update(channelSessions)
        .set({ acceptedMessageIds: [...new Set([...session.acceptedMessageIds, messageId])] })
        .where(eq(channelSessions.id, session.id));
      await this.audit(tx, channelId, 'draft_published', runId, { messageId });
      return messageId;
    });
  }

  async stop(channelId: string, scope: { runId: string } | { threadId: string | null }) {
    await this.db.transaction(async (tx) => {
      await this.owned(tx, channelId, true, true);
      if ('threadId' in scope) {
        await this.scope(tx, channelId, scope.threadId);
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
      for (const run of runs.filter((r) => !r.publishedMessageId || !r.writerReleased)) {
        await tx
          .update(channelRuns)
          .set({ publicationRevoked: true, status: 'stop_requested' })
          .where(eq(channelRuns.id, run.id));
        if (!run.writerReleased) await this.outbox(tx, channelId, 'stop', run.id);
      }
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
  ) {
    await this.db.transaction(async (tx) => {
      const run = await this.fenced(tx, channelId, runId, fence, true);
      await tx
        .update(channelRuns)
        .set({
          error: message,
          status: executionUnknown ? 'execution_unknown' : 'failed',
          publicationRevoked: true,
        })
        .where(eq(channelRuns.id, run.id));
      await tx.update(channelJobs).set({ status: 'failed' }).where(eq(channelJobs.id, run.jobId));
      await this.audit(tx, channelId, 'execution_failed', run.id, { message, executionUnknown });
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
      await tx
        .update(channelRuns)
        .set({
          writerReleased: true,
          error: run.status === 'failed' ? run.error : null,
          status:
            run.status === 'failed' ? 'failed' : run.publicationRevoked ? 'stopped' : 'completed',
        })
        .where(eq(channelRuns.id, run.id));
      await tx.delete(channelWorkspaceLocks).where(eq(channelWorkspaceLocks.runId, run.id));
      await this.audit(tx, channelId, 'writer_terminated', run.id);
    });
  }
}

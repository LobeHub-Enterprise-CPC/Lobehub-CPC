import type {
  ChannelDiscussionStatus,
  ChannelDiscussionTask,
  ChannelInputManifest,
  ChannelJobBlockCode,
  ChannelJobStatus,
  ChannelMemberConfig,
  ChannelPublicationStatus,
  ChannelRunStatus,
  UIChatMessage,
} from '@lobechat/types';
import { sql } from 'drizzle-orm';
import type { PgTableExtraConfigValue } from 'drizzle-orm/pg-core';
import {
  boolean,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * Database schema for the Channel MVP (LOBE-14026).
 *
 * ## Why this lives here and not in `packages/database/src/schemas`
 *
 * These tables are ours (CPC-only), not upstream's. Declared in the shared
 * schema barrel, their migrations would land in the shared drizzle chain — the
 * same namespace canary's own migrations use. That collides on every canary
 * merge (the exact failure mode `command_governance`'s tables hit twice,
 * `0158`/`0159` renumbered to `0161`/`0162`, each time costing a hand-rebuilt
 * snapshot chain).
 *
 * Ownership sits with the tenant-only chain (`migrations/tenant`, bookkeeping
 * in `__lobehub_tenant_migrations`), which canary does not have and therefore
 * cannot collide with. `src/tenant/schemas.ts` re-exports this file as the
 * entry of that chain's drizzle config, so `drizzle-kit generate` with
 * `DRIZZLE_TARGET=tenant` picks it up from here, and `packages/database/migrations`
 * stays byte-identical to canary (outside `tenant` and `platform`).
 *
 * Two consequences worth knowing before editing:
 *
 * 1. **Self-contained on purpose.** No `./_helpers` import, and no path alias
 *    of any kind: the models are kept free of the shared schema graph. The
 *    timestamp column is spelled out below instead of importing
 *    `createdAt`/`timestamptz`.
 * 2. **No `.references(() => users.id)`.** `users` belongs to the shared
 *    chain; importing it would pull it into the tenant chain's schema graph and
 *    `drizzle-kit generate` would try to create `users` there too.
 *    `channels.owner_id`'s foreign key to `users` still exists in the
 *    database — it is written by hand in `0004_governance_channel_tables.sql`,
 *    together with the revision triggers. Keep it in sync if this column
 *    changes.
 */

const createdAtColumn = () =>
  timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const timestamptzColumn = (name: string) => timestamp(name, { withTimezone: true });

// Native private transcripts and checkpoints never enter channel_messages or legacy messages.
export const channelRuntimeMessages = pgTable(
  'channel_runtime_messages',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => channelSessions.id, { onDelete: 'cascade' }),
    runId: text('run_id')
      .notNull()
      .references(() => channelRuns.id, { onDelete: 'cascade' }),
    stableKey: text('stable_key').notNull(),
    data: jsonb('data').$type<UIChatMessage>().notNull(),
    createdAt: createdAtColumn(),
  },
  (t): PgTableExtraConfigValue[] => [
    uniqueIndex('channel_runtime_messages_key_idx').on(t.sessionId, t.stableKey),
  ],
);

export const channelRuntimeStates = pgTable('channel_runtime_states', {
  sessionId: text('session_id')
    .primaryKey()
    .references(() => channelSessions.id, { onDelete: 'cascade' }),
  runId: text('run_id')
    .notNull()
    .references(() => channelRuns.id, { onDelete: 'cascade' }),
  state: jsonb('state').$type<Record<string, unknown>>().notNull(),
});

export const channels = pgTable(
  'channels',
  {
    id: text('id').primaryKey(),
    ownerId: text('owner_id').notNull(),
    title: text('title').notNull(),
    sequence: integer('sequence').notNull().default(0),
    /**
     * Bumped by database triggers whenever this Channel or its members, threads, messages,
     * jobs, runs or discussions change (see 0017_channel_revision.sql). Watchers compare it
     * instead of serializing and hashing every live row.
     */
    revision: integer('revision').notNull().default(0),
    archived: boolean('archived').notNull().default(false),
    createdAt: createdAtColumn(),
  },
  (t): PgTableExtraConfigValue[] => [index('channels_owner_idx').on(t.ownerId)],
);

export const channelMembers = pgTable(
  'channel_members',
  {
    id: text('id').primaryKey(),
    channelId: text('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    config: jsonb('config').$type<ChannelMemberConfig>().notNull(),
    active: boolean('active').notNull().default(true),
    executionPaused: boolean('execution_paused').notNull().default(false),
    environmentRevision: integer('environment_revision').notNull().default(0),
    /** Messages before a switch must not be delivered late into the new environment. */
    environmentCutoff: integer('environment_cutoff').notNull().default(0),
    createdAt: createdAtColumn(),
  },
  (t): PgTableExtraConfigValue[] => [
    // Composite foreign keys reference (channel_id, id). A table constraint is
    // created with the table, so generated migrations have it before those keys.
    unique('channel_members_scope_idx').on(t.channelId, t.id),
  ],
);

export const channelThreads = pgTable(
  'channel_threads',
  {
    id: text('id').primaryKey(),
    channelId: text('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    rootMessageId: text('root_message_id').notNull(),
    rootSequence: integer('root_sequence').notNull(),
    followerMemberIds: jsonb('follower_member_ids').$type<string[]>().notNull().default([]),
    createdAt: createdAtColumn(),
  },
  (t): PgTableExtraConfigValue[] => [
    uniqueIndex('channel_threads_root_idx').on(t.channelId, t.rootMessageId),
    unique('channel_threads_scope_idx').on(t.channelId, t.id),
    foreignKey({
      columns: [t.channelId, t.rootMessageId],
      foreignColumns: [channelMessages.channelId, channelMessages.id],
      name: 'channel_threads_root_fk',
    }),
  ],
);

export const channelMessages = pgTable(
  'channel_messages',
  {
    id: text('id').primaryKey(),
    channelId: text('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    threadId: text('thread_id'),
    sequence: integer('sequence').notNull(),
    authorMemberId: text('author_member_id'),
    content: text('content').notNull(),
    fileIds: jsonb('file_ids').$type<string[]>().notNull().default([]),
    mentions: jsonb('mentions').$type<string[]>().notNull().default([]),
    /** Client retry identity for user messages; run identity for published drafts. */
    requestKey: text('request_key').notNull(),
    replyToId: text('reply_to_id'),
    routingStatus: text('routing_status', {
      enum: ['directed', 'pending', 'assigned', 'unassigned', 'reply'],
    }).notNull(),
    routingReason: text('routing_reason'),
    createdAt: createdAtColumn(),
  },
  (t): PgTableExtraConfigValue[] => [
    unique('channel_messages_scope_idx').on(t.channelId, t.id),
    uniqueIndex('channel_messages_seq_idx').on(t.channelId, t.sequence),
    index('channel_messages_thread_sequence_idx').on(t.channelId, t.threadId, t.sequence),
    index('channel_messages_request_sequence_idx')
      .on(t.channelId, t.threadId, t.sequence)
      .where(sql`${t.authorMemberId} IS NULL`),
    index('channel_messages_routing_pending_idx')
      .on(t.channelId, t.id)
      .where(sql`${t.routingStatus} = 'pending'`),
    uniqueIndex('channel_messages_request_idx').on(t.channelId, t.requestKey),
    foreignKey({
      columns: [t.channelId, t.threadId],
      foreignColumns: [channelThreads.channelId, channelThreads.id],
      name: 'channel_messages_thread_fk',
    }),
    foreignKey({
      columns: [t.channelId, t.authorMemberId],
      foreignColumns: [channelMembers.channelId, channelMembers.id],
      name: 'channel_messages_author_fk',
    }),
  ],
);

export const channelDiscussions = pgTable(
  'channel_discussions',
  {
    id: text('id').primaryKey(),
    channelId: text('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    requestMessageId: text('request_message_id')
      .notNull()
      .references(() => channelMessages.id, { onDelete: 'cascade' }),
    threadId: text('thread_id'),
    participantIds: jsonb('participant_ids').$type<string[]>().notNull(),
    maxRounds: integer('max_rounds').notNull(),
    /** 1-based. Every participant gets one turn per round; the next round opens once all settle. */
    round: integer('round').notNull().default(1),
    /** Published discuss/revise replies across all rounds. Yielded, held or failed attempts never count. */
    turnsPublished: integer('turns_published').notNull().default(0),
    status: text('status').$type<ChannelDiscussionStatus>().notNull().default('active'),
    endReason: text('end_reason'),
    summaryMessageId: text('summary_message_id'),
    createdAt: createdAtColumn(),
  },
  (t): PgTableExtraConfigValue[] => [
    index('channel_discussions_channel_status_idx').on(t.channelId, t.status),
    index('channel_discussions_request_idx').on(t.requestMessageId),
  ],
);

export const channelJobs = pgTable(
  'channel_jobs',
  {
    id: text('id').primaryKey(),
    channelId: text('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    memberId: text('member_id').notNull(),
    messageId: text('message_id').notNull(),
    threadId: text('thread_id'),
    discussionId: text('discussion_id').references(() => channelDiscussions.id, {
      onDelete: 'cascade',
    }),
    task: jsonb('task').$type<ChannelDiscussionTask>(),
    deliveryKey: text('delivery_key').notNull().default('initial'),
    status: text('status').$type<ChannelJobStatus>().notNull().default('queued'),
    blockedReason: text('blocked_reason'),
    /** Machine-readable cause for blockedReason; clients must not parse the text. */
    blockedCode: text('blocked_code').$type<ChannelJobBlockCode>(),
    createdAt: createdAtColumn(),
  },
  (t): PgTableExtraConfigValue[] => [
    uniqueIndex('channel_jobs_delivery_idx').on(t.messageId, t.memberId, t.deliveryKey),
    unique('channel_jobs_scope_idx').on(t.channelId, t.id),
    index('channel_jobs_queue_idx').on(t.status, t.createdAt),
    index('channel_jobs_channel_status_idx').on(t.channelId, t.status),
    foreignKey({
      columns: [t.channelId, t.memberId],
      foreignColumns: [channelMembers.channelId, channelMembers.id],
      name: 'channel_jobs_member_fk',
    }),
    foreignKey({
      columns: [t.channelId, t.messageId],
      foreignColumns: [channelMessages.channelId, channelMessages.id],
      name: 'channel_jobs_message_fk',
    }),
    foreignKey({
      columns: [t.channelId, t.threadId],
      foreignColumns: [channelThreads.channelId, channelThreads.id],
      name: 'channel_jobs_thread_fk',
    }),
  ],
);

export const channelSessions = pgTable(
  'channel_sessions',
  {
    id: text('id').primaryKey(),
    channelId: text('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    memberId: text('member_id').notNull(),
    /** main or a Channel Thread id; no runtime topic identity. */
    scope: text('scope').notNull(),
    generation: integer('generation').notNull().default(1),
    nativeSessionId: text('native_session_id'),
    acceptedMessageIds: jsonb('accepted_message_ids').$type<string[]>().notNull().default([]),
    createdAt: createdAtColumn(),
  },
  (t): PgTableExtraConfigValue[] => [
    uniqueIndex('channel_sessions_member_scope_idx').on(t.memberId, t.scope),
    foreignKey({
      columns: [t.channelId, t.memberId],
      foreignColumns: [channelMembers.channelId, channelMembers.id],
      name: 'channel_sessions_member_fk',
    }),
  ],
);

export const channelRuns = pgTable(
  'channel_runs',
  {
    id: text('id').primaryKey(),
    channelId: text('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    jobId: text('job_id').notNull(),
    memberId: text('member_id').notNull(),
    sessionId: text('session_id')
      .notNull()
      .references(() => channelSessions.id),
    status: text('status').$type<ChannelRunStatus>().notNull().default('starting'),
    activity: text('activity').$type<'running' | 'typing'>(),
    fence: integer('fence').notNull().default(1),
    /** Device receipt authority never changes when a draft gets a new publication fence. */
    executionFence: integer('execution_fence').notNull().default(1),
    executionConfig: jsonb('execution_config').$type<ChannelMemberConfig>(),
    environmentRevision: integer('environment_revision').notNull().default(0),
    physicalStopped: boolean('physical_stopped').notNull().default(false),
    cleanupRequested: boolean('cleanup_requested').notNull().default(false),
    environmentError: text('environment_error'),
    manifest: jsonb('manifest').$type<ChannelInputManifest>().notNull(),
    acceptance: text('acceptance', { enum: ['pending', 'accepted', 'unknown'] })
      .notNull()
      .default('pending'),
    nativeTurnId: text('native_turn_id'),
    publicationRevoked: boolean('publication_revoked').notNull().default(false),
    /** Only physical confirmation releases this; leases/idle/interrupt do not. */
    writerReleased: boolean('writer_released').notNull().default(false),
    /**
     * Logical isolation of a writer whose termination could not be confirmed in time. Its
     * publication is revoked and its native session retired, so the member may run again;
     * `writerReleased`/`physicalStopped` still record only physical confirmation.
     */
    isolatedAt: timestamptzColumn('isolated_at'),
    draft: text('draft'),
    publicationStatus: text('publication_status')
      .$type<ChannelPublicationStatus>()
      .notNull()
      .default('pending'),
    publishedMessageId: text('published_message_id'),
    error: text('error'),
    createdAt: createdAtColumn(),
  },
  (t): PgTableExtraConfigValue[] => [
    uniqueIndex('channel_runs_job_idx').on(t.jobId),
    index('channel_runs_channel_idx').on(t.channelId),
    index('channel_runs_unsettled_idx')
      .on(t.channelId, t.id)
      .where(sql`${t.writerReleased} = false OR ${t.physicalStopped} = false`),
    uniqueIndex('channel_runs_active_member_idx')
      .on(t.memberId)
      .where(sql`${t.writerReleased} = false AND ${t.isolatedAt} IS NULL`),
    foreignKey({
      columns: [t.channelId, t.jobId],
      foreignColumns: [channelJobs.channelId, channelJobs.id],
      name: 'channel_runs_job_fk',
    }),
    foreignKey({
      columns: [t.channelId, t.memberId],
      foreignColumns: [channelMembers.channelId, channelMembers.id],
      name: 'channel_runs_member_fk',
    }),
  ],
);

export const channelOutbox = pgTable(
  'channel_outbox',
  {
    id: text('id').primaryKey(),
    channelId: text('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['route', 'execute', 'publish', 'stop'] }).notNull(),
    targetId: text('target_id').notNull(),
    processed: boolean('processed').notNull().default(false),
    createdAt: createdAtColumn(),
  },
  (t): PgTableExtraConfigValue[] => [
    index('channel_outbox_pending_idx').on(t.processed, t.createdAt),
  ],
);

export const channelAudit = pgTable(
  'channel_audit',
  {
    id: text('id').primaryKey(),
    channelId: text('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    event: text('event').notNull(),
    targetId: text('target_id').notNull(),
    details: jsonb('details').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAtColumn(),
  },
  (t): PgTableExtraConfigValue[] => [
    index('channel_audit_channel_event_idx').on(t.channelId, t.event, t.createdAt),
    index('channel_audit_target_event_idx').on(t.targetId, t.event, t.createdAt),
  ],
);

export const channelApprovals = pgTable(
  'channel_approvals',
  {
    id: text('id').primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => channelRuns.id, { onDelete: 'cascade' }),
    request: jsonb('request').$type<Record<string, unknown>>().notNull(),
    decision: text('decision', { enum: ['approved', 'rejected', 'expired'] }),
    expiresAt: timestamptzColumn('expires_at').notNull(),
    createdAt: createdAtColumn(),
  },
  (t): PgTableExtraConfigValue[] => [index('channel_approvals_run_idx').on(t.runId)],
);

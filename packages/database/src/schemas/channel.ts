import type {
  ChannelInputManifest,
  ChannelJobStatus,
  ChannelMemberConfig,
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
  uniqueIndex,
} from 'drizzle-orm/pg-core';

import { createdAt, timestamptz } from './_helpers';
import { users } from './user';

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
    createdAt: createdAt(),
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
    ownerId: text('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    sequence: integer('sequence').notNull().default(0),
    archived: boolean('archived').notNull().default(false),
    createdAt: createdAt(),
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
    createdAt: createdAt(),
  },
  (t): PgTableExtraConfigValue[] => [
    uniqueIndex('channel_members_scope_idx').on(t.channelId, t.id),
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
    createdAt: createdAt(),
  },
  (t): PgTableExtraConfigValue[] => [
    uniqueIndex('channel_threads_root_idx').on(t.channelId, t.rootMessageId),
    uniqueIndex('channel_threads_scope_idx').on(t.channelId, t.id),
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
    mentions: jsonb('mentions').$type<string[]>().notNull().default([]),
    /** Client retry identity for user messages; run identity for published drafts. */
    requestKey: text('request_key').notNull(),
    replyToId: text('reply_to_id'),
    routingStatus: text('routing_status', {
      enum: ['directed', 'pending', 'assigned', 'unassigned', 'reply'],
    }).notNull(),
    routingReason: text('routing_reason'),
    createdAt: createdAt(),
  },
  (t): PgTableExtraConfigValue[] => [
    uniqueIndex('channel_messages_scope_idx').on(t.channelId, t.id),
    uniqueIndex('channel_messages_seq_idx').on(t.channelId, t.sequence),
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
    status: text('status').$type<ChannelJobStatus>().notNull().default('queued'),
    createdAt: createdAt(),
  },
  (t): PgTableExtraConfigValue[] => [
    uniqueIndex('channel_jobs_delivery_idx').on(t.messageId, t.memberId),
    uniqueIndex('channel_jobs_scope_idx').on(t.channelId, t.id),
    index('channel_jobs_queue_idx').on(t.status, t.createdAt),
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
    createdAt: createdAt(),
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
    fence: integer('fence').notNull().default(1),
    manifest: jsonb('manifest').$type<ChannelInputManifest>().notNull(),
    acceptance: text('acceptance', { enum: ['pending', 'accepted', 'unknown'] })
      .notNull()
      .default('pending'),
    nativeTurnId: text('native_turn_id'),
    publicationRevoked: boolean('publication_revoked').notNull().default(false),
    /** Only physical confirmation releases this; leases/idle/interrupt do not. */
    writerReleased: boolean('writer_released').notNull().default(false),
    draft: text('draft'),
    publishedMessageId: text('published_message_id'),
    error: text('error'),
    createdAt: createdAt(),
  },
  (t): PgTableExtraConfigValue[] => [
    uniqueIndex('channel_runs_job_idx').on(t.jobId),
    uniqueIndex('channel_runs_active_member_idx')
      .on(t.memberId)
      .where(sql`${t.writerReleased} = false`),
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

export const channelWorkspaceLocks = pgTable(
  'channel_workspace_locks',
  {
    id: text('id').primaryKey(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    deviceId: text('device_id').notNull(),
    directory: text('directory').notNull(),
    runId: text('run_id')
      .notNull()
      .references(() => channelRuns.id),
    createdAt: createdAt(),
  },
  (t): PgTableExtraConfigValue[] => [
    uniqueIndex('channel_workspace_locks_resource_idx').on(t.ownerId, t.deviceId, t.directory),
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
    createdAt: createdAt(),
  },
  (t): PgTableExtraConfigValue[] => [
    index('channel_outbox_pending_idx').on(t.processed, t.createdAt),
  ],
);

export const channelAudit = pgTable('channel_audit', {
  id: text('id').primaryKey(),
  channelId: text('channel_id')
    .notNull()
    .references(() => channels.id, { onDelete: 'cascade' }),
  event: text('event').notNull(),
  targetId: text('target_id').notNull(),
  details: jsonb('details').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: createdAt(),
});

export const channelApprovals = pgTable('channel_approvals', {
  id: text('id').primaryKey(),
  runId: text('run_id')
    .notNull()
    .references(() => channelRuns.id, { onDelete: 'cascade' }),
  request: jsonb('request').$type<Record<string, unknown>>().notNull(),
  decision: text('decision', { enum: ['approved', 'rejected', 'expired'] }),
  expiresAt: timestamptz('expires_at').notNull(),
  createdAt: createdAt(),
});

import { boolean, index, integer, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { createdAt, timestamptz, updatedAt } from '../schemas/_helpers';

/** Durable identity of one child-to-parent tool completion, scoped by tenant schema. */
export const agentSubAgentBridges = pgTable(
  'agent_sub_agent_bridges',
  {
    id: uuid('id').defaultRandom().primaryKey().notNull(),
    childOperationId: text('child_operation_id').notNull(),
    parentOperationId: text('parent_operation_id').notNull(),
    userId: text('user_id').notNull(),
    workspaceId: text('workspace_id'),
    includeShareVisitor: boolean('include_share_visitor').default(false).notNull(),
    threadId: text('thread_id').notNull(),
    toolMessageId: text('tool_message_id').notNull(),
    childRunToken: text('child_run_token').notNull(),
    waitingBatchId: text('waiting_batch_id').notNull(),
    status: text('status')
      .$type<'pending' | 'delivered' | 'recovered' | 'failed'>()
      .default('pending')
      .notNull(),
    completionReason: text('completion_reason'),
    attempts: integer('attempts').default(0).notNull(),
    lastError: text('last_error'),
    leaseOwner: text('lease_owner'),
    leaseUntil: timestamptz('lease_until'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('agent_sub_agent_bridges_child_operation_id_idx').on(t.childOperationId),
    index('agent_sub_agent_bridges_status_updated_at_idx').on(t.status, t.updatedAt),
    index('agent_sub_agent_bridges_parent_operation_id_idx').on(t.parentOperationId),
  ],
);

export type NewAgentSubAgentBridge = typeof agentSubAgentBridges.$inferInsert;

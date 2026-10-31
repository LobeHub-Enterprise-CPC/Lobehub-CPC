import type { CreateThreadParams, ThreadMetadata } from '@lobechat/types';
import { RequestTrigger, ThreadStatus } from '@lobechat/types';
import { and, desc, eq, inArray, isNull, notExists, or, sql } from 'drizzle-orm';

import type { ThreadItem } from '../schemas';
import { agentOperations, messages, threads } from '../schemas';
import type { LobeChatDatabase } from '../type';
import { buildWorkspacePayload, buildWorkspaceWhere } from '../utils/workspace';

/**
 * Per-thread subagent metrics, derived from the child messages at read time
 * (single source of truth = the messages, not a denormalized write). Mirrors
 * `aggregateSubagentMetrics` in the app: SUM of assistant `usage.totalTokens`
 * (prefer the promoted `usage` column, fall back to legacy `metadata.usage`),
 * COUNT of `role='tool'`, and a pinned model. Folded onto `metadata.*` so the
 * subagent inspector chip can read it without hydrating the child messages.
 */
const subagentMetricColumns = {
  _model: sql<
    string | null
  >`MAX(CASE WHEN ${messages.role} = 'assistant' THEN ${messages.model} END)`.as('_sa_model'),
  _totalToolCalls: sql<number>`COUNT(CASE WHEN ${messages.role} = 'tool' THEN 1 END)`.as(
    '_sa_tool_calls',
  ),
  _totalTokens:
    sql<number>`COALESCE(SUM(CASE WHEN ${messages.role} = 'assistant' THEN (COALESCE(${messages.usage}, ${messages.metadata} -> 'usage') ->> 'totalTokens')::numeric END), 0)`.as(
      '_sa_total_tokens',
    ),
};

type ThreadMetricRow = ThreadItem & {
  _model: string | null;
  _totalToolCalls: number | string;
  _totalTokens: number | string;
};

/** Fold the SQL-derived metric columns onto `metadata` and drop the temp keys. */
const foldSubagentMetrics = (rows: ThreadMetricRow[]): ThreadItem[] =>
  rows.map(({ _model, _totalToolCalls, _totalTokens, ...thread }) => {
    const totalToolCalls = Number(_totalToolCalls);
    const totalTokens = Number(_totalTokens);
    return {
      ...thread,
      metadata: {
        ...thread.metadata,
        ...(totalToolCalls > 0 && { totalToolCalls }),
        ...(totalTokens > 0 && { totalTokens }),
        ...(_model && { model: _model }),
      },
    };
  });

const queryColumns = {
  agentId: threads.agentId,
  createdAt: threads.createdAt,
  groupId: threads.groupId,
  id: threads.id,
  metadata: threads.metadata,
  parentThreadId: threads.parentThreadId,
  sourceMessageId: threads.sourceMessageId,
  status: threads.status,
  title: threads.title,
  topicId: threads.topicId,
  type: threads.type,
  updatedAt: threads.updatedAt,
};

export class ThreadModel {
  private userId: string;
  private db: LobeChatDatabase;
  private workspaceId?: string;

  constructor(db: LobeChatDatabase, userId: string, workspaceId?: string) {
    this.userId = userId;
    this.db = db;
    this.workspaceId = workspaceId;
  }

  private ownership = () =>
    buildWorkspaceWhere({ userId: this.userId, workspaceId: this.workspaceId }, threads);

  /**
   * In workspace mode `ownership()` matches every member's threads, so a bulk
   * "clear all" would wipe teammates' rows. Destructive sweeps must
   * additionally pin `user_id` to the caller (personal mode is unchanged —
   * ownership already scopes to the user there).
   */
  private mine = () => and(this.ownership(), eq(threads.userId, this.userId));

  create = async (params: CreateThreadParams) => {
    // @ts-ignore
    const [result] = await this.db
      .insert(threads)
      .values(
        buildWorkspacePayload(
          { userId: this.userId, workspaceId: this.workspaceId },
          { status: ThreadStatus.Active, ...params },
        ),
      )
      .onConflictDoNothing()
      .returning();

    return result;
  };

  delete = async (id: string) => {
    return this.db.delete(threads).where(and(eq(threads.id, id), this.ownership()));
  };

  deleteAll = async () => {
    return this.db.delete(threads).where(this.mine());
  };

  query = async () => {
    const data = await this.db
      .select(queryColumns)
      .from(threads)
      .where(this.ownership())
      .orderBy(desc(threads.updatedAt));

    return data as ThreadItem[];
  };

  queryByTopicId = async (topicId: string) => {
    // LEFT JOIN + GROUP BY threads.id (PK ⇒ Postgres lets us select the plain
    // thread columns alongside the per-thread aggregates). `threadId` join
    // naturally scopes to in-thread rows, excluding the spawning parent.
    const data = await this.db
      .select({ ...queryColumns, ...subagentMetricColumns })
      .from(threads)
      .leftJoin(messages, eq(messages.threadId, threads.id))
      .where(
        and(
          eq(threads.topicId, topicId),
          this.ownership(),
          sql`COALESCE(${threads.metadata} ->> 'onboardingUnderstanding', '') = ''`,
          // NOTICE:
          // Internal Agent Signal and onboarding Understanding runs create
          // isolation threads that must stay out of the user-facing sub-agent
          // attachment list. Ordinary onboarding threads remain visible.
          notExists(
            this.db
              .select({ id: agentOperations.id })
              .from(agentOperations)
              .where(
                and(
                  eq(agentOperations.threadId, threads.id),
                  eq(agentOperations.trigger, RequestTrigger.AgentSignal),
                ),
              ),
          ),
        ),
      )
      .groupBy(threads.id)
      .orderBy(desc(threads.updatedAt));

    return foldSubagentMetrics(data as ThreadMetricRow[]);
  };

  findById = async (id: string) => {
    return this.db.query.threads.findFirst({
      where: and(eq(threads.id, id), this.ownership()),
    });
  };

  /**
   * Compare-and-set an existing thread into `processing` for a new run.
   *
   * Succeeds only while the row still carries the `status` and
   * `metadata.operationId` the caller validated, so two concurrent follow-ups
   * to the same sub-agent thread cannot both start a run on it.
   *
   * @returns whether this caller won the claim
   */
  claimForRun = async (
    id: string,
    expected: { operationId?: string | null; status?: ThreadItem['status'] },
    metadata: ThreadMetadata,
  ): Promise<boolean> => {
    const rows = await this.db
      .update(threads)
      .set({ metadata, status: ThreadStatus.Processing, updatedAt: new Date() })
      .where(
        and(
          eq(threads.id, id),
          this.ownership(),
          expected.status ? eq(threads.status, expected.status) : isNull(threads.status),
          // COALESCE instead of `IS NULL` on the extracted path: a bare jsonb null
          // test breaks the planner once the table carries a pg_search index (see
          // `__tests__/jsonbNullTest.test.ts`).
          expected.operationId
            ? sql`${threads.metadata} ->> 'operationId' = ${expected.operationId}`
            : sql`COALESCE(${threads.metadata} ->> 'operationId', '') = ''`,
        ),
      )
      .returning({ id: threads.id });

    return rows.length > 0;
  };

  /** Rotate an approval continuation's generation before its operation starts. */
  setRunToken = async (
    id: string,
    runToken: string,
    sourceOperationId: string,
  ): Promise<boolean> => {
    const thread = await this.findById(id);
    if (!thread) return false;
    // A crash/retry after rotation must not reset B's progress.
    if (thread.metadata?.runToken === runToken) return true;
    if (thread.metadata?.operationId !== sourceOperationId) return false;
    const rows = await this.db
      .update(threads)
      .set({
        metadata: sql`(COALESCE(${threads.metadata}, '{}'::jsonb) - 'progressStep' - 'progressOperationId') || ${JSON.stringify({ runToken })}::jsonb`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(threads.id, id),
          this.ownership(),
          inArray(threads.status, [ThreadStatus.Processing, ThreadStatus.InReview]),
          sql`${threads.metadata} ->> 'operationId' = ${sourceOperationId}`,
          sql`${threads.metadata} ->> 'runToken' = ${thread.metadata?.runToken ?? ''}`,
        ),
      )
      .returning({ id: threads.id });
    return rows.length > 0;
  };

  /** Link a newly created operation without clobbering a faster completion. */
  linkRunOperation = async (
    id: string,
    runToken: string,
    operationId: string,
  ): Promise<boolean> => {
    const rows = await this.db
      .update(threads)
      .set({
        metadata: sql`COALESCE(${threads.metadata}, '{}'::jsonb) || ${JSON.stringify({ operationId })}::jsonb`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(threads.id, id),
          this.ownership(),
          sql`${threads.metadata} ->> 'runToken' = ${runToken}`,
        ),
      )
      .returning({ id: threads.id });
    return rows.length > 0;
  };

  /** A failed startup must not retire a newer generation or an already completed run. */
  failRun = async (id: string, runToken: string, metadata: ThreadMetadata): Promise<boolean> => {
    const rows = await this.db
      .update(threads)
      .set({
        metadata: sql`COALESCE(${threads.metadata}, '{}'::jsonb) || ${JSON.stringify({ ...metadata, runToken })}::jsonb`,
        status: ThreadStatus.Failed,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(threads.id, id),
          this.ownership(),
          inArray(threads.status, [ThreadStatus.Processing, ThreadStatus.InReview]),
          sql`${threads.metadata} ->> 'runToken' = ${runToken}`,
        ),
      )
      .returning({ id: threads.id });
    return rows.length > 0;
  };

  /** Progress is monotonic within each operation of the current run generation. */
  updateProgressForRun = async (
    id: string,
    runToken: string,
    operationId: string,
    progressStep: number,
    metadata: ThreadMetadata,
  ): Promise<boolean> => {
    const rows = await this.db
      .update(threads)
      .set({
        metadata: sql`COALESCE(${threads.metadata}, '{}'::jsonb) || ${JSON.stringify({ ...metadata, operationId, progressOperationId: operationId, progressStep, runToken })}::jsonb`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(threads.id, id),
          this.ownership(),
          inArray(threads.status, [ThreadStatus.Processing, ThreadStatus.InReview]),
          sql`${threads.metadata} ->> 'runToken' = ${runToken}`,
          or(
            sql`COALESCE(${threads.metadata} ->> 'progressOperationId' <> ${operationId}, true)`,
            sql`COALESCE((${threads.metadata} ->> 'progressStep')::integer, -1) < ${progressStep}`,
          ),
        ),
      )
      .returning({ id: threads.id });
    return rows.length > 0;
  };

  /** Human review is resumable; only a true ending consumes final-completion identity. */
  completeRun = async (
    id: string,
    runToken: string,
    operationId: string,
    status: ThreadStatus,
    metadata: ThreadMetadata,
  ): Promise<boolean> => {
    const rows = await this.db
      .update(threads)
      .set({
        metadata: sql`COALESCE(${threads.metadata}, '{}'::jsonb) || ${JSON.stringify({ ...metadata, ...(status !== ThreadStatus.InReview && { completedOperationId: operationId }), operationId, runToken })}::jsonb`,
        status,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(threads.id, id),
          this.ownership(),
          inArray(threads.status, [ThreadStatus.Processing, ThreadStatus.InReview]),
          sql`${threads.metadata} ->> 'runToken' = ${runToken}`,
          or(
            sql`COALESCE(${threads.metadata} ->> 'completedOperationId', '') <> ${operationId}`,
            // Historical waiting callbacks wrote the final marker too.
            ...(status !== ThreadStatus.InReview
              ? [eq(threads.status, ThreadStatus.InReview)]
              : []),
          ),
          ...(status === ThreadStatus.InReview
            ? [
                or(
                  eq(threads.status, ThreadStatus.Processing),
                  sql`COALESCE(${threads.metadata} ->> 'operationId', '') <> ${operationId}`,
                ),
              ]
            : []),
        ),
      )
      .returning({ id: threads.id });
    return rows.length > 0;
  };

  update = async (id: string, value: Partial<ThreadItem>) => {
    return this.db
      .update(threads)
      .set({ ...value, updatedAt: new Date() })
      .where(and(eq(threads.id, id), this.ownership()));
  };
}

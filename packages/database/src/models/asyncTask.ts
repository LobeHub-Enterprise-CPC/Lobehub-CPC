import { ASYNC_TASK_TIMEOUT, VIDEO_GENERATION_TASK_TIMEOUT } from '@lobechat/business-config/server';
import type {
  HourlyUserMemoryExtractionMetadata,
  HourlyUserMemoryExtractionProgress,
  UserMemoryExtractionMetadata,
} from '@lobechat/types';
import {
  AsyncTaskError,
  AsyncTaskErrorType,
  AsyncTaskStatus,
  AsyncTaskType,
} from '@lobechat/types';
import { and, eq, inArray, or, sql } from 'drizzle-orm';

import type { AsyncTaskSelectItem, NewAsyncTaskItem } from '../schemas';
import { asyncTasks } from '../schemas';
import type { LobeChatDatabase } from '../type';
import { buildWorkspacePayload, buildWorkspaceWhere } from '../utils/workspace';

/**
 * Deadline used by the watchdog, per async task type.
 *
 * Video generation waits on a remote render that is observed through a callback or a
 * poll, so it must not share the generic deadline: the poller starts after submission
 * and its own budget is close to ASYNC_TASK_TIMEOUT, which is what made the watchdog
 * kill tasks that were still legitimately in flight. See the budget notes in
 * `packages/business/config/src/server/route.ts`.
 */
const timeoutForTaskType = (type?: AsyncTaskType | string | null) =>
  type === AsyncTaskType.VideoGeneration ? VIDEO_GENERATION_TASK_TIMEOUT : ASYNC_TASK_TIMEOUT;

export class AsyncTaskModel {
  private userId: string;
  private db: LobeChatDatabase;
  private workspaceId?: string;

  constructor(db: LobeChatDatabase, userId: string, workspaceId?: string) {
    this.userId = userId;
    this.db = db;
    this.workspaceId = workspaceId;
  }

  private ownership = () =>
    buildWorkspaceWhere({ userId: this.userId, workspaceId: this.workspaceId }, asyncTasks);

  create = async (
    params: Pick<NewAsyncTaskItem, 'type' | 'status' | 'metadata' | 'parentId'>,
  ): Promise<string> => {
    const data = await this.db
      .insert(asyncTasks)
      .values(
        buildWorkspacePayload(
          { userId: this.userId, workspaceId: this.workspaceId },
          { ...params },
        ),
      )
      .returning();

    return data[0].id;
  };

  delete = async (id: string) => {
    return this.db.delete(asyncTasks).where(and(eq(asyncTasks.id, id), this.ownership()));
  };

  findById = async (id: string) => {
    return this.db.query.asyncTasks.findFirst({
      where: and(eq(asyncTasks.id, id), this.ownership()),
    });
  };

  static findByInferenceId = async (db: LobeChatDatabase, inferenceId: string) => {
    return db.query.asyncTasks.findFirst({
      where: eq(asyncTasks.inferenceId, inferenceId),
    });
  };

  /**
   * Atomically claims the right to finalize a video task (store the asset, charge, notify).
   *
   * Webhook retries (the handler answers 503 while the provider file is still processing) and the
   * background polling fallback can both reach completion for the same task. The claim is a single
   * compare-and-set UPDATE — still active AND no `completionClaimedAt` yet — so exactly one caller
   * wins; do not split it into a read followed by a write, or completion may run twice.
   * @returns `true` when this caller owns the completion, `false` when it was already claimed or finalized
   */
  static claimVideoCompletion = async (
    db: LobeChatDatabase,
    taskId: string,
    completionEventId?: string,
  ) => {
    const claimedAt = new Date().toISOString();
    const metadataWithClaim = sql`
      jsonb_set(
        COALESCE(${asyncTasks.metadata}, '{}'::jsonb),
        '{completionClaimedAt}',
        to_jsonb(${claimedAt}::text),
        true
      )
    `;

    const [claimed] = await db
      .update(asyncTasks)
      .set({
        metadata: completionEventId
          ? sql`
              jsonb_set(
                ${metadataWithClaim},
                '{completionEventId}',
                to_jsonb(${completionEventId}::text),
                true
              )
            `
          : metadataWithClaim,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(asyncTasks.id, taskId),
          inArray(asyncTasks.status, [AsyncTaskStatus.Pending, AsyncTaskStatus.Processing]),
          sql`NOT (COALESCE(${asyncTasks.metadata}, '{}'::jsonb) ? 'completionClaimedAt')`,
        ),
      )
      .returning({ id: asyncTasks.id });

    return Boolean(claimed);
  };

  update(taskId: string, value: Partial<AsyncTaskSelectItem>) {
    return this.db
      .update(asyncTasks)
      .set({ ...value, updatedAt: new Date() })
      .where(and(eq(asyncTasks.id, taskId), this.ownership()));
  }

  findActiveByType = async (type: AsyncTaskType) => {
    return this.db.query.asyncTasks.findFirst({
      where: and(
        this.ownership(),
        eq(asyncTasks.type, type),
        inArray(asyncTasks.status, [AsyncTaskStatus.Pending, AsyncTaskStatus.Processing]),
      ),
    });
  };

  incrementUserMemoryExtractionProgress = async (taskId: string) => {
    const completedExpr = sql<number>`COALESCE(((${asyncTasks.metadata}) -> 'progress' ->> 'completedTopics')::int, 0) + 1`;
    const totalExpr = sql<
      number | null
    >`((${asyncTasks.metadata}) -> 'progress' ->> 'totalTopics')::int`;

    const result = await this.db
      .update(asyncTasks)
      .set({
        metadata: sql`
          jsonb_set(
            jsonb_set(
              ${asyncTasks.metadata},
              '{progress,completedTopics}',
              to_jsonb(${completedExpr}),
              true
            ),
            '{progress,totalTopics}',
            COALESCE((${asyncTasks.metadata}) -> 'progress' -> 'totalTopics', 'null'::jsonb),
            true
          )
        `,
        // Verified on pg_search 0.15.26: `UPDATE … SET`, SELECT lists and ORDER
        // BY all survive a null test over an extracted jsonb value; only quals
        // (WHERE / JOIN ON / HAVING) crash the planner. `async_tasks` carries no
        // bm25 index either. See the block comment above `TopicModel`.
        // jsonb-null-test-safe: SET target list, not a qual
        status: sql`
          CASE
            WHEN ${asyncTasks.status} = ${AsyncTaskStatus.Error} OR ${asyncTasks.error} IS NOT NULL
              THEN ${AsyncTaskStatus.Error}
            WHEN ${totalExpr} IS NOT NULL AND ${completedExpr} >= ${totalExpr}
              THEN ${AsyncTaskStatus.Success}
            ELSE ${AsyncTaskStatus.Processing}
          END
        `,
        updatedAt: new Date(),
      })
      .where(and(eq(asyncTasks.id, taskId), this.ownership()))
      .returning({ metadata: asyncTasks.metadata, status: asyncTasks.status });

    return result[0];
  };

  findByIds = async (taskIds: string[], type: AsyncTaskType): Promise<AsyncTaskSelectItem[]> => {
    let chunkTasks: AsyncTaskSelectItem[] = [];

    if (taskIds.length > 0) {
      await this.checkTimeoutTasks(taskIds, type);
      chunkTasks = await this.db.query.asyncTasks.findMany({
        where: and(inArray(asyncTasks.id, taskIds), eq(asyncTasks.type, type), this.ownership()),
      });
    }

    return chunkTasks;
  };

  isUserMemoryExtractionCancellationRequested = async (taskId: string) => {
    // NOTICE: Shared cancellation gate for cooperative cascading cancellation.
    // Workflow stages call this before fan-out/heavy steps to stop the remaining task tree.
    const task = await this.findById(taskId);
    if (!task || task.userId !== this.userId) return false;
    if (task.type !== AsyncTaskType.UserMemoryExtractionWithChatTopic) return false;

    const metadata = task.metadata as UserMemoryExtractionMetadata | undefined;
    return Boolean(metadata?.control?.cancelRequestedAt);
  };

  appendUserMemoryWorkflowRunIds = async (taskId: string, workflowRunIds: string[]) => {
    const uniqueIds = Array.from(new Set(workflowRunIds.filter(Boolean)));
    if (uniqueIds.length === 0) return;

    const incomingIdsJson = JSON.stringify(uniqueIds);
    const mergedIdsExpr = sql`
      (
        SELECT COALESCE(jsonb_agg(value ORDER BY first_ordinal), '[]'::jsonb)
        FROM (
          SELECT value, MIN(ordinality) AS first_ordinal
          FROM jsonb_array_elements_text(
            COALESCE(
              ${asyncTasks.metadata} #> '{control,upstash,workflowRunIds}',
              '[]'::jsonb
            ) || ${incomingIdsJson}::jsonb
          ) WITH ORDINALITY AS ids(value, ordinality)
          GROUP BY value
        ) AS deduped_ids
      )
    `;

    await this.db
      .update(asyncTasks)
      .set({
        metadata: sql`
          jsonb_set(
            jsonb_set(
              jsonb_set(
                ${asyncTasks.metadata},
                '{control}',
                COALESCE(${asyncTasks.metadata} -> 'control', '{}'::jsonb),
                true
              ),
              '{control,upstash}',
              COALESCE(${asyncTasks.metadata} #> '{control,upstash}', '{}'::jsonb),
              true
            ),
            '{control,upstash,workflowRunIds}',
            ${mergedIdsExpr},
            true
          )
        `,
        updatedAt: new Date(),
      })
      .where(and(eq(asyncTasks.id, taskId), this.ownership()));
  };

  markHourlyMemoryExtractionSuccess = async (
    taskId: string,
    progress: HourlyUserMemoryExtractionProgress & { status: AsyncTaskStatus.Success },
  ) => {
    await this.db
      .update(asyncTasks)
      .set({
        metadata: sql`
          jsonb_set(
            jsonb_set(
              jsonb_set(
                ${asyncTasks.metadata},
                '{progress,processedUsers}',
                to_jsonb(${progress.processedUsers}::int),
                true
              ),
              '{progress,scheduledBatches}',
              to_jsonb(${progress.scheduledBatches}::int),
              true
            ),
            '{progress,scheduledChildRuns}',
            to_jsonb(${progress.scheduledChildRuns}::int),
            true
          )
        `,
        status: sql`
          CASE
            WHEN ${asyncTasks.status} = ${AsyncTaskStatus.Error} OR ${asyncTasks.error} IS NOT NULL
              THEN ${AsyncTaskStatus.Error}
            ELSE ${progress.status}
          END
        `,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(asyncTasks.id, taskId),
          eq(asyncTasks.type, AsyncTaskType.UserMemoryExtractionHourly),
          this.ownership(),
        ),
      );
  };

  isHourlyMemoryExtractionCancellationRequested = async (taskId: string) => {
    const task = await this.findById(taskId);
    if (!task || task.userId !== this.userId) return false;
    if (task.type !== AsyncTaskType.UserMemoryExtractionHourly) return false;

    const metadata = task.metadata as HourlyUserMemoryExtractionMetadata | undefined;
    return Boolean(metadata?.control?.cancelRequestedAt);
  };

  /**
   * Mark tasks that are past their deadline as `error`.
   *
   * The deadline depends on the task type and callers that only hold ids cannot know
   * it (`getGenerationStatus` guards a single video task without passing a type), so
   * candidates are read first and only the rows past *their own* deadline are expired.
   *
   * @param ids task ids to consider
   * @param type optional known type; when omitted each row's own type decides
   */
  checkTimeoutTasks = async (ids: string[], type?: AsyncTaskType) => {
    if (ids.length === 0) return;

    const activeStatuses = or(
      eq(asyncTasks.status, AsyncTaskStatus.Pending),
      eq(asyncTasks.status, AsyncTaskStatus.Processing),
    );

    const candidates = await this.db
      .select({ createdAt: asyncTasks.createdAt, id: asyncTasks.id, type: asyncTasks.type })
      .from(asyncTasks)
      .where(and(inArray(asyncTasks.id, ids), this.ownership(), activeStatuses));

    const now = Date.now();
    const expiredIds = candidates
      .filter((task) => now - task.createdAt.getTime() > timeoutForTaskType(type ?? task.type))
      .map((task) => task.id);

    if (expiredIds.length === 0) return;

    await this.db
      .update(asyncTasks)
      .set({
        error: new AsyncTaskError(AsyncTaskErrorType.Timeout, 'task is timeout, please try again'),
        status: AsyncTaskStatus.Error,
      })
      .where(
        and(
          inArray(asyncTasks.id, expiredIds),
          this.ownership(),
          // Re-check the status: the task may have been finalized by the poller, the
          // callback or a duplicate watchdog between the read above and this write, and
          // a completed task must not be pushed back to `error`.
          activeStatuses,
        ),
      );
  };
}

export const initUserMemoryExtractionMetadata = (
  metadata?: UserMemoryExtractionMetadata,
): UserMemoryExtractionMetadata => ({
  control: metadata?.control
    ? {
        cancelReason: metadata.control.cancelReason,
        cancelRequestedAt: metadata.control.cancelRequestedAt,
        cancelledBy: metadata.control.cancelledBy,
        upstash: metadata.control.upstash
          ? {
              entryWorkflowRunId: metadata.control.upstash.entryWorkflowRunId,
              workflowRunIds: metadata.control.upstash.workflowRunIds || [],
            }
          : undefined,
      }
    : undefined,
  progress: {
    completedTopics: metadata?.progress?.completedTopics ?? 0,
    totalTopics: metadata?.progress?.totalTopics ?? null,
  },
  range: metadata?.range,
  source: metadata?.source ?? 'chat_topic',
});

/**
 * Initializes hourly user memory extraction metadata.
 *
 * Use when:
 * - Creating the batch-level hourly extraction async task
 * - Normalizing persisted hourly extraction metadata before updates
 *
 * Expects:
 * - `startedAt` is the ISO timestamp for the hourly scheduler run
 *
 * Returns:
 * - Hourly metadata with progress counters defaulted to zero
 */
export const initHourlyUserMemoryExtractionMetadata = (
  metadata: Partial<HourlyUserMemoryExtractionMetadata> & { startedAt: string },
): HourlyUserMemoryExtractionMetadata => ({
  control: metadata.control
    ? {
        cancelReason: metadata.control.cancelReason,
        cancelRequestedAt: metadata.control.cancelRequestedAt,
        cancelledBy: metadata.control.cancelledBy,
        upstash: metadata.control.upstash
          ? {
              entryWorkflowRunId: metadata.control.upstash.entryWorkflowRunId,
              workflowRunIds: metadata.control.upstash.workflowRunIds || [],
            }
          : undefined,
      }
    : undefined,
  cursor: metadata.cursor,
  progress: {
    processedUsers: metadata.progress?.processedUsers ?? 0,
    scheduledBatches: metadata.progress?.scheduledBatches ?? 0,
    scheduledChildRuns: metadata.progress?.scheduledChildRuns ?? 0,
  },
  source: 'hourly_chat_topic',
  startedAt: metadata.startedAt,
});

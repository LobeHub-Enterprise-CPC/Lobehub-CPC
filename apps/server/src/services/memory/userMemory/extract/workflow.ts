import { and, eq, sql } from 'drizzle-orm';

import {
  AsyncTaskModel,
  initHourlyUserMemoryExtractionMetadata,
} from '@/database/models/asyncTask';
import { asyncTasks } from '@/database/schemas';
import { getServerDB } from '@/database/server';
import { parseMemoryExtractionConfig } from '@/server/globalConfig/parseMemoryExtractionConfig';
import { buildTenantCallbackUrl } from '@/server/modules/Tenant/callbackUrl';
import { type FlowControl, workflowClient } from '@/server/modules/Workflow';
import {
  AsyncTaskError,
  AsyncTaskErrorType,
  AsyncTaskStatus,
  AsyncTaskType,
} from '@/types/asyncTask';

import type {
  MemoryExtractionHourlyWorkflowPayload,
  MemoryExtractionPayloadInput,
  UserTopicWorkflowPayload,
} from './payload';

const WORKFLOW_PATHS = {
  hourly: '/api/workflows/memory-user-memory/call-cron-hourly-analysis',
  personaUpdate: '/api/workflows/memory-user-memory/pipelines/persona/update-writing',
  userTopics: '/api/workflows/memory-user-memory/pipelines/chat-topic/process-user-topics',
  users: '/api/workflows/memory-user-memory/pipelines/chat-topic/process-users',
} as const;

const PROCESS_USERS_FLOW_CONTROL = {
  key: 'memory-user-memory.pipelines.chat-topic.process-users',
  parallelism: 1,
  ratePerSecond: 1,
} satisfies FlowControl;

const getProcessUserTopicsFlowControl = (): FlowControl => {
  const { workflow } = parseMemoryExtractionConfig();

  return {
    key: 'memory-user-memory.pipelines.chat-topic.process-user-topics',
    // NOTICE: Trigger-side flow control is required for initial workflow delivery.
    // A serve() flowControl setting alone is applied after the run starts, so it cannot prevent
    // many process-user-topics runs from entering execution at the same time.
    parallelism: workflow?.processUserTopicsParallelism ?? 25,
  };
};

const buildHourlyChildWorkflowRunId = (entryWorkflowRunId: string) =>
  `memory-user-memory-hourly-${entryWorkflowRunId.replaceAll(/[^\w-]/g, '_')}`;

// The tenant is read when the trigger runs (always inside the tenant that
// owns the extraction), never carried in `baseUrl`.
const getWorkflowUrl = (path: string, baseUrl: string) => buildTenantCallbackUrl(path, baseUrl);

export class MemoryExtractionWorkflowService {
  static triggerProcessUsers(
    payload: MemoryExtractionPayloadInput,
    options?: { extraHeaders?: Record<string, string> },
  ) {
    if (!payload.baseUrl) {
      throw new Error('Missing baseUrl for workflow trigger');
    }

    const url = getWorkflowUrl(WORKFLOW_PATHS.users, payload.baseUrl);
    return workflowClient.trigger({
      body: payload,
      flowControl: PROCESS_USERS_FLOW_CONTROL,
      headers: options?.extraHeaders,
      url,
    });
  }

  static triggerHourly(
    payload: MemoryExtractionHourlyWorkflowPayload,
    options?: { extraHeaders?: Record<string, string>; workflowRunId?: string },
  ) {
    if (!payload.baseUrl) {
      throw new Error('Missing baseUrl for workflow trigger');
    }

    const url = getWorkflowUrl(WORKFLOW_PATHS.hourly, payload.baseUrl);
    return workflowClient.trigger({
      body: payload,
      headers: options?.extraHeaders,
      url,
      workflowRunId: options?.workflowRunId,
    });
  }

  /**
   * Creates a batch-level async task and triggers hourly memory extraction.
   *
   * Use when:
   * - Starting the hourly user-memory extraction workflow from cron or an operator action
   * - Tracking the root workflow run id for later cooperative cancellation
   *
   * Expects:
   * - `payload.baseUrl` is present for workflow URL construction
   * - `MEMORY_EXTRACTION_HOURLY_TASK_USER_ID` identifies the service-account task owner
   *
   * Returns:
   * - The created async task id and root Upstash workflow run id
   */
  static async triggerHourlyTracked(
    payload: MemoryExtractionHourlyWorkflowPayload,
    options?: { entryWorkflowRunId?: string; extraHeaders?: Record<string, string> },
  ) {
    if (!payload.baseUrl) {
      throw new Error('Missing baseUrl for workflow trigger');
    }

    const userId = process.env.MEMORY_EXTRACTION_HOURLY_TASK_USER_ID;
    if (!userId) {
      throw new Error(
        'MEMORY_EXTRACTION_HOURLY_TASK_USER_ID is required for tracked hourly extraction',
      );
    }

    const db = await getServerDB();
    const startedAt = new Date().toISOString();
    const childWorkflowRunId = options?.entryWorkflowRunId
      ? buildHourlyChildWorkflowRunId(options.entryWorkflowRunId)
      : undefined;
    const existingTask = options?.entryWorkflowRunId
      ? await db.query.asyncTasks.findFirst({
          where: and(
            eq(asyncTasks.type, AsyncTaskType.UserMemoryExtractionHourly),
            eq(asyncTasks.userId, userId),
            sql`${asyncTasks.metadata} #>> '{control,upstash,entryWorkflowRunId}' = ${options.entryWorkflowRunId}`,
          ),
        })
      : undefined;
    const asyncTaskModel = new AsyncTaskModel(db, userId);
    const taskId =
      existingTask?.id ??
      (await asyncTaskModel.create({
        metadata: initHourlyUserMemoryExtractionMetadata({
          control: options?.entryWorkflowRunId
            ? {
                upstash: {
                  entryWorkflowRunId: options.entryWorkflowRunId,
                  workflowRunIds: [
                    options.entryWorkflowRunId,
                    ...(childWorkflowRunId ? [childWorkflowRunId] : []),
                  ],
                },
              }
            : undefined,
          cursor: payload.cursor,
          startedAt,
        }),
        status: AsyncTaskStatus.Pending,
        type: AsyncTaskType.UserMemoryExtractionHourly,
      }));
    let workflowRunId: string;
    try {
      ({ workflowRunId } = await this.triggerHourly(
        { ...payload, hourlyTaskId: taskId },
        { extraHeaders: options?.extraHeaders, workflowRunId: childWorkflowRunId },
      ));
    } catch (error) {
      const statusCode =
        (error as { status?: number; statusCode?: number }).status ??
        (error as { statusCode?: number }).statusCode;
      const message = error instanceof Error ? error.message.toLowerCase() : '';
      if (
        existingTask &&
        childWorkflowRunId &&
        (statusCode === 409 || message.includes('already'))
      ) {
        await asyncTaskModel.appendUserMemoryWorkflowRunIds(taskId, [childWorkflowRunId]);
        return { taskId, workflowRunId: childWorkflowRunId };
      }

      await asyncTaskModel.update(taskId, {
        error: new AsyncTaskError(
          AsyncTaskErrorType.TaskTriggerError,
          'Failed to schedule hourly memory extraction workflow',
        ),
        status: AsyncTaskStatus.Error,
      });
      throw error;
    }

    await asyncTaskModel.appendUserMemoryWorkflowRunIds(taskId, [workflowRunId]);

    return { taskId, workflowRunId };
  }

  static triggerProcessUserTopics(
    payload: UserTopicWorkflowPayload,
    options?: { extraHeaders?: Record<string, string> },
  ) {
    if (!payload.baseUrl) {
      throw new Error('Missing baseUrl for workflow trigger');
    }

    const url = getWorkflowUrl(WORKFLOW_PATHS.userTopics, payload.baseUrl);
    return workflowClient.trigger({
      body: payload,
      flowControl: getProcessUserTopicsFlowControl(),
      headers: options?.extraHeaders,
      url,
    });
  }

  static triggerPersonaUpdate(
    userId: string,
    baseUrl: string,
    options?: { extraHeaders?: Record<string, string>; hourlyTaskId?: string },
  ) {
    if (!baseUrl) {
      throw new Error('Missing baseUrl for workflow trigger');
    }

    const url = getWorkflowUrl(WORKFLOW_PATHS.personaUpdate, baseUrl);
    return workflowClient.trigger({
      body: { hourlyTaskId: options?.hourlyTaskId, userIds: [userId] },
      flowControl: {
        key: `memory-user-memory.pipelines.persona.update-write.${userId}`,
        parallelism: 1,
      } satisfies FlowControl,
      headers: options?.extraHeaders,
      url,
    });
  }
}

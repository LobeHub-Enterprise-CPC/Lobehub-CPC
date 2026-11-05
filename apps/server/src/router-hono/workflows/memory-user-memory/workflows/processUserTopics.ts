import { LayersEnum, MemorySourceType } from '@lobechat/types';
import { errorMessageFrom } from '@lobechat/utils';

import { AsyncTaskModel } from '@/database/models/asyncTask';
import { type ListTopicsForMemoryExtractorCursor } from '@/database/models/topic';
import { getServerDB } from '@/database/server';
import { parseMemoryExtractionConfig } from '@/server/globalConfig/parseMemoryExtractionConfig';
import { noteActivity } from '@/server/modules/RuntimeActivity';
import { type WorkflowContext } from '@/server/modules/Workflow';
import {
  type MemoryExtractionNormalizedPayload,
  type MemoryExtractionPayloadInput,
} from '@/server/services/memory/userMemory/extract';
import {
  MemoryExtractionExecutor,
  MemoryExtractionWorkflowService,
  normalizeMemoryExtractionPayload,
} from '@/server/services/memory/userMemory/extract';
import { redisService } from '@/server/services/redis';
import { parseWorkflowDate, runStep } from '@/server/workflows/step';

import { checkGuard, ensureWorkflowStarted } from './runGuard';
import { appendHourlyWorkflowRunId, isHourlyMemoryExtractionCancelled } from './utils';

const TOPIC_PAGE_SIZE = 50;
const WORKFLOW_PATH = 'api/workflows/memory-user-memory/pipelines/chat-topic/process-user-topics';
const PROCESS_USER_TOPICS_FLOW_CONTROL_KEY =
  'memory-user-memory.pipelines.chat-topic.process-user-topics';

// Experience extraction is retired: nothing surfaces those rows any more, and what they were
// reaching for now belongs to skills.
const ALL_LAYERS: LayersEnum[] = [
  LayersEnum.Context,
  LayersEnum.Preference,
  LayersEnum.Activity,
  LayersEnum.Identity,
];

/**
 * Segments one run extracts from a single topic's backlog; the rest waits for a later run, so
 * one huge conversation cannot hold up the user's other topics.
 */
const MAX_SEGMENTS_PER_TOPIC_PER_RUN = 5;

/** A user-initiated run that finds the user's lease taken waits up to this long for it. */
const LEASE_WAIT_SECONDS = 60;
const LEASE_WAIT_ATTEMPTS = 30;

const { upstashWorkflowExtraHeaders, workflow } = parseMemoryExtractionConfig();

// NOTICE: Hard per-user, per-run topic ceiling. Remaining topics are picked up by later runs.
const MAX_TOPICS_PER_USER_PER_RUN = workflow?.maxTopicsPerUserPerRun ?? 100;

type Context = WorkflowContext<MemoryExtractionPayloadInput>;

const GUARD_STOPPED = {
  message: 'Memory workflow run guard matched, stop topic processing.',
  processedUsers: 0,
  skipped: true,
} as const;

interface TopicOutcome {
  error?: string;
  extractedThrough?: string;
  failed?: boolean;
  hasMore?: boolean;
  /** Another run took the user over (this one outlasted the lease). */
  leaseLost?: boolean;
  memoryCount: number;
}

/**
 * One line per extracted segment and per user run, so what a run did (extracted, nothing new,
 * skipped, failed) can be read from the logs instead of inferred from topic metadata.
 */
const logOutcome = (event: 'memory.run' | 'memory.topic', fields: Record<string, unknown>) =>
  console.info(JSON.stringify({ event, ...fields }));

interface UserOutcome {
  createdMemories: number;
  processedTopics: number;
  stopped?: string;
}

/**
 * Extracts one user's chat topics: the topics with conversation left to extract, one after
 * another, each from its watermark on and in one call for every layer; then refreshes the
 * user's persona once if anything new was remembered.
 *
 * One run per user at a time (see `userMemoryExtractionLease`). An hourly run that finds the user busy
 * leaves them to the next hour; a user-initiated one waits for the lease.
 */
export const processUserTopicsHandler = async (context: Context) => {
  await ensureWorkflowStarted(context, WORKFLOW_PATH);

  const params = normalizeMemoryExtractionPayload(context.requestPayload || {});

  // NOTICE: Return (never throw) on a guard match — a throw before the first step makes Upstash
  // re-enqueue the run, turning a "disable" guard into an infinite retry storm.
  const entryGuard = await checkGuard(context, WORKFLOW_PATH);
  if (!entryGuard.result) return entryGuard.response;

  if (!params.userIds.length) {
    return { message: 'No user ids provided for topic processing.' };
  }
  if (!params.sources.includes(MemorySourceType.ChatTopic)) {
    return { message: 'No supported sources requested, skip topic processing.' };
  }

  // An explicit request keeps only the layers still extracted; one naming nothing but the
  // retired Experience layer has no work left (the executor reads an empty list as "all").
  const layers = params.layers.length
    ? params.layers.filter((layer) => ALL_LAYERS.includes(layer))
    : ALL_LAYERS;
  if (layers.length === 0) {
    return { message: 'No supported layers requested, skip topic processing.', skipped: true };
  }

  const users: Record<string, UserOutcome | { skipped: string }> = {};
  for (const userId of params.userIds) {
    const stopped = await checkCancelled(context, params, userId, 'start');
    if (stopped === 'guard') return GUARD_STOPPED;
    if (stopped) {
      users[userId] = { skipped: stopped };
      continue;
    }

    const lease = await takeUserLease(context, userId, params);
    if (!lease) {
      users[userId] = { skipped: 'another memory extraction run is working on this user' };
      logOutcome('memory.run', { outcome: 'skipped:lease', runId: context.workflowRunId, userId });
      continue;
    }

    noteActivity({ userId });
    const outcome = await processUser(context, params, userId, layers, lease === 'held');
    // A lease another run took over is theirs now.
    if (outcome.stopped !== 'lease') {
      await runStep(context, `memory:user-memory:extract:users:${userId}:release-lease`, () =>
        redisService.userMemoryExtractionLease.release(userId, context.workflowRunId),
      );
    }
    logOutcome('memory.run', {
      memories: outcome.createdMemories,
      outcome: outcome.stopped ? `stopped:${outcome.stopped}` : 'done',
      runId: context.workflowRunId,
      topics: outcome.processedTopics,
      userId,
    });
    if (outcome.stopped === 'guard') return GUARD_STOPPED;
    users[userId] = outcome;
  }

  return { processedUsers: params.userIds.length, users };
};

const processUser = async (
  context: Context,
  params: MemoryExtractionNormalizedPayload,
  userId: string,
  layers: LayersEnum[],
  holdsLease: boolean,
): Promise<UserOutcome> => {
  const executor = await MemoryExtractionExecutor.create();
  const outcome: UserOutcome = { createdMemories: 0, processedTopics: 0 };

  let explicitTopicIds: string[] | undefined;
  if (params.topicIds.length > 0) {
    const stepName = `memory:user-memory:extract:users:${userId}:filter-topic-ids`;
    const guard = await checkGuard(context, WORKFLOW_PATH, { stepName });
    if (!guard.result) return { ...outcome, stopped: 'guard' };

    explicitTopicIds = await runStep(context, stepName, async () => {
      const filtered = await executor.filterTopicIdsForUser(
        userId,
        params.topicIds,
        params.workspaceId,
      );
      return filtered.length > 0 ? filtered : undefined;
    });
  }

  let cursor: { createdAt: string; id: string } | undefined;
  while (true) {
    const listStep = `memory:user-memory:extract:users:${userId}:list-topics:${cursor?.id || 'root'}`;
    const listGuard = await checkGuard(context, WORKFLOW_PATH, { stepName: listStep });
    if (!listGuard.result) return { ...outcome, stopped: 'guard' };

    const page = await runStep<{ cursor?: ListTopicsForMemoryExtractorCursor; ids: string[] }>(
      context,
      listStep,
      () =>
        explicitTopicIds
          ? { ids: explicitTopicIds }
          : executor.getTopicsForUser(
              {
                cursor: cursor && {
                  // The cursor crossed a step boundary, so its timestamp arrives as an ISO string.
                  createdAt: parseWorkflowDate(
                    cursor.createdAt,
                    'Invalid topic cursor date from the previous topic page',
                  ),
                  id: cursor.id,
                },
                forceAll: params.forceAll,
                forceTopics: params.forceTopics,
                from: params.from,
                to: params.to,
                userId,
                userInitiated: params.userInitiated,
                workspaceId: params.workspaceId,
              },
              TOPIC_PAGE_SIZE,
            ),
    );

    // Explicit topic ids are what the user asked for and are never capped.
    const topicIds = explicitTopicIds
      ? page.ids
      : page.ids.slice(0, Math.max(0, MAX_TOPICS_PER_USER_PER_RUN - outcome.processedTopics));

    for (const topicId of topicIds) {
      const stopped = await checkCancelled(context, params, userId, `topics:${topicId}`);
      if (stopped) return { ...outcome, stopped };

      const topic = await extractTopicBacklog(context, params, executor, userId, topicId, layers, {
        holdsLease,
      });
      if (topic === 'guard' || topic === 'lease') return { ...outcome, stopped: topic };
      outcome.createdMemories += topic;
      outcome.processedTopics += 1;

      if (params.asyncTaskId && params.userInitiated) {
        await runStep(
          context,
          `memory:user-memory:extract:users:${userId}:topics:${topicId}:progress`,
          () =>
            getServerDB().then((db) =>
              new AsyncTaskModel(
                db,
                userId,
                params.workspaceId,
              ).incrementUserMemoryExtractionProgress(params.asyncTaskId!),
            ),
        );
      }
    }

    const nextCursor = page.cursor;
    if (
      explicitTopicIds ||
      page.ids.length === 0 ||
      !nextCursor ||
      outcome.processedTopics >= MAX_TOPICS_PER_USER_PER_RUN
    )
      break;
    cursor = { createdAt: String(nextCursor.createdAt), id: nextCursor.id };
  }

  if (outcome.createdMemories > 0) {
    const stopped = await checkCancelled(context, params, userId, 'persona');
    if (stopped) return { ...outcome, stopped };

    const personaStep = `memory:user-memory:users:${userId}`;
    const guard = await checkGuard(context, WORKFLOW_PATH, { stepName: personaStep });
    if (!guard.result) return { ...outcome, stopped: 'guard' };

    const persona = await runStep(context, personaStep, () =>
      MemoryExtractionWorkflowService.triggerPersonaUpdate(userId, params.baseUrl, {
        extraHeaders: upstashWorkflowExtraHeaders,
        hourlyTaskId: params.hourlyTaskId,
      }),
    );
    await appendHourlyWorkflowRunId(params.hourlyTaskId, persona.workflowRunId);
  }

  return outcome;
};

/**
 * Extracts a topic segment by segment from its watermark, up to the per-run ceiling. A failing
 * topic is recorded as failed by the extractor and does not stop the user's other topics.
 * Returns how many memories it created.
 */
const extractTopicBacklog = async (
  context: Context,
  params: MemoryExtractionNormalizedPayload,
  executor: MemoryExtractionExecutor,
  userId: string,
  topicId: string,
  layers: LayersEnum[],
  { holdsLease }: { holdsLease: boolean },
): Promise<number | 'guard' | 'lease'> => {
  let created = 0;
  let resumeFrom: string | undefined;

  for (let segment = 0; segment < MAX_SEGMENTS_PER_TOPIC_PER_RUN; segment += 1) {
    const stepName = `memory:user-memory:extract:users:${userId}:topics:${topicId}:extract:${segment}`;
    const guard = await checkGuard(context, WORKFLOW_PATH, { stepName });
    if (!guard.result) return 'guard';

    const outcome = await runStep<TopicOutcome>(context, stepName, async () => {
      noteActivity({ segment, topicId, userId });
      const startedAt = Date.now();
      const done = (topic: TopicOutcome, reason: string) => {
        logOutcome('memory.topic', {
          error: topic.error?.slice(0, 300),
          hasMore: topic.hasMore,
          memories: topic.memoryCount,
          ms: Date.now() - startedAt,
          outcome: reason,
          runId: context.workflowRunId,
          segment,
          topicId,
          userId,
        });
        return topic;
      };
      // Inside the step, so a replay of finished work never takes the lease again.
      if (
        holdsLease &&
        !(await redisService.userMemoryExtractionLease.hold(userId, context.workflowRunId))
      )
        return done({ leaseLost: true, memoryCount: 0 }, 'lease_lost');
      try {
        const result = await executor.extractTopic({
          asyncTaskId: params.asyncTaskId,
          forceAll: params.forceAll,
          forceTopics: params.forceTopics,
          from: params.from,
          layers,
          reportProgress: false,
          resumeFrom,
          source: MemorySourceType.ChatTopic,
          to: params.to,
          topicId,
          userId,
          userInitiated: params.userInitiated,
          workspaceId: params.workspaceId,
        });
        return done(
          {
            extractedThrough: result.extractedThrough,
            hasMore: result.hasMore,
            memoryCount: result.memoryIds.length,
          },
          result.extracted ? 'extracted' : (result.reason ?? 'not_extracted'),
        );
      } catch (error) {
        return done({ error: errorMessageFrom(error), failed: true, memoryCount: 0 }, 'failed');
      }
    });

    if (outcome.leaseLost) return 'lease';
    created += outcome.memoryCount;
    if (outcome.failed || !outcome.hasMore || !outcome.extractedThrough) break;
    resumeFrom = outcome.extractedThrough;
  }

  return created;
};

/**
 * Takes the user's lease. A user-initiated run waits for it, sleeping between attempts; an
 * unattended one gives up at once and leaves the user to the next run. `unheld` is a
 * user-initiated run that waited long enough and goes ahead without it.
 */
const takeUserLease = async (
  context: Context,
  userId: string,
  params: MemoryExtractionNormalizedPayload,
): Promise<'held' | 'unheld' | false> => {
  const attempts = params.userInitiated ? LEASE_WAIT_ATTEMPTS : 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const held = await runStep(
      context,
      `memory:user-memory:extract:users:${userId}:lease:${attempt}`,
      () => redisService.userMemoryExtractionLease.acquire(userId, context.workflowRunId),
    );
    if (held) return 'held';
    if (attempt + 1 < attempts) {
      await context.sleep(
        `memory:user-memory:extract:users:${userId}:lease-wait:${attempt}`,
        LEASE_WAIT_SECONDS,
      );
    }
  }
  // Waited long enough: the user asked for this, so it goes ahead.
  return params.userInitiated === true ? 'unheld' : false;
};

/**
 * The run guard, the cancellation a user requested, and the hourly task's cancellation, checked
 * before each unit of work. Returns why work must stop, or undefined to go on.
 */
const checkCancelled = async (
  context: Context,
  params: MemoryExtractionNormalizedPayload,
  userId: string,
  at: string,
): Promise<string | undefined> => {
  const stepName = `memory:user-memory:extract:users:${userId}:${at}:cancel-check`;
  const guard = await checkGuard(context, WORKFLOW_PATH, { stepName });
  if (!guard.result) return 'guard';

  const cancelled = await runStep(context, stepName, async () => {
    if (await isHourlyMemoryExtractionCancelled(params.hourlyTaskId)) return 'hourly';
    if (!params.asyncTaskId) return undefined;
    const db = await getServerDB();
    const requested = await new AsyncTaskModel(
      db,
      userId,
      params.workspaceId,
    ).isUserMemoryExtractionCancellationRequested(params.asyncTaskId);
    return requested ? 'requested' : undefined;
  });
  return cancelled ? `memory extraction cancelled (${cancelled})` : undefined;
};

/**
 * Shared flow-control settings for active user-topic workers.
 *
 * Use when:
 * - Serving process-user-topics workflow runs
 * - Keeping memory extraction bounded to the configured active user worker limit
 *
 * Expects:
 * - Trigger-side calls use the same key to throttle initial workflow delivery
 *
 * Returns:
 * - Workflow serve options that limit process-user-topics executions
 */
export const processUserTopicsWorkflowOptions = {
  // NOTICE: This key intentionally omits userId. Adding userId would create one independent
  // bucket per user and would not cap total database pressure; the global key keeps at most
  // the configured number of user-topic workers active across all users.
  flowControl: {
    key: PROCESS_USER_TOPICS_FLOW_CONTROL_KEY,
    parallelism: workflow?.processUserTopicsParallelism ?? 25,
  },
};

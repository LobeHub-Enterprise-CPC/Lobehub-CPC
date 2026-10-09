import { VIDEO_GENERATION_POLL_TIMEOUT } from '@lobechat/business-config/server';
import {
  buildMappedBusinessModelFields,
  resolveBusinessModelMapping,
} from '@lobechat/business-model-runtime';
import type { PollVideoStatusResult, VideoGenerationUsage } from '@lobechat/model-runtime';
import { RequestTrigger, type SpendOrigin, type VideoGenerationRoute } from '@lobechat/types';
import debug from 'debug';
import type { RuntimeVideoGenParams } from 'model-bank';

import { getProviderContentPolicyErrorMessage } from '@/business/server/getProviderContentPolicyErrorMessage';
import { trackProviderContentPolicyViolation } from '@/business/server/trackProviderContentPolicyViolation';
import { chargeAfterGenerate } from '@/business/server/video-generation/chargeAfterGenerate';
import { notifyVideoCompleted } from '@/business/server/video-generation/notifyVideoCompleted';
import { AsyncTaskModel } from '@/database/models/asyncTask';
import { GenerationModel } from '@/database/models/generation';
import type { LobeChatDatabase } from '@/database/type';
import { initModelRuntimeFromDB } from '@/server/modules/ModelRuntime';
import { VideoGenerationService } from '@/server/services/generation/video';
import { buildVideoGenerationFilePayload } from '@/server/services/generation/videoFile';
import { measureVideoOutputUsage } from '@/server/services/generation/videoOutputUsage';
import { AsyncTaskError, AsyncTaskErrorType, AsyncTaskStatus } from '@/types/asyncTask';
import { FileSource } from '@/types/files';
import type { VideoGenerationAsset } from '@/types/generation';

const log = debug('lobe-video:background-polling');

/**
 * Raised when the provider reports a terminal failure for the task, or a success
 * without a usable URL.
 *
 * It is deliberately distinguishable from transport errors: a poller that runs as a
 * fallback next to a provider callback may not turn a network hiccup into a task
 * failure, but an authoritative upstream failure must still surface immediately.
 */
export class VideoGenerationFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VideoGenerationFailedError';
  }
}

/** A single status query must not be able to consume the whole polling budget. */
const STATUS_QUERY_TIMEOUT = 30_000;

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });

  try {
    // `Promise.race<T>([...])` is explicit on purpose. Left to inference, the array
    // widens to `Promise<T> | Promise<never>` and `race` resolves to `unknown`, which
    // erases the discriminated union the caller switches on (`status === 'success'`).
    return await Promise.race<T>([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

interface BackgroundPollingParams {
  asyncTaskCreatedAt: Date;
  asyncTaskId: string;
  generationBatchId: string;
  generationId: string;
  generationTopicId: string;
  inferenceId: string;
  model: string;
  /**
   * True when a provider callback is also expected for this task.
   *
   * The poller must then stay non-authoritative on failure: a transport error or an
   * exhausted poll budget leaves the task in Processing for the callback, and only an
   * explicit upstream failure finalizes it. The task deadline is the backstop.
   */
  pollingIsFallback?: boolean;
  prechargeResult?: any;
  previousGenerationId?: string;
  provider: string;
  route?: VideoGenerationRoute;
  /** Keeps the completion charge attributed like the webhook path, which reads it from the task row. */
  spendOrigin?: SpendOrigin;
  userId: string;
  workspaceId?: string;
}

export async function processBackgroundVideoPolling(
  db: LobeChatDatabase,
  params: BackgroundPollingParams,
): Promise<void> {
  const {
    asyncTaskCreatedAt,
    asyncTaskId,
    generationBatchId,
    generationId,
    generationTopicId,
    inferenceId,
    model,
    pollingIsFallback,
    prechargeResult,
    previousGenerationId,
    provider,
    route,
    spendOrigin,
    userId,
    workspaceId,
  } = params;

  log(
    'Starting background video polling for task: %s (provider: %s, inferenceId: %s)',
    asyncTaskId,
    provider,
    inferenceId,
  );

  let claimedByThisWorker = false;

  try {
    const asyncTaskModel = new AsyncTaskModel(db, userId, workspaceId);
    const videoService = new VideoGenerationService(db, userId, workspaceId);
    const generationModel = new GenerationModel(db, userId, workspaceId);

    const modelRuntime = await initModelRuntimeFromDB(db, userId, provider, workspaceId);
    // `route` was pinned for the mapped model id at creation, so poll with that id too;
    // the user-facing alias may resolve to a router list that no longer holds the route.
    const { resolvedModelId: pollModelId } = await resolveBusinessModelMapping(provider, model);
    const pollResult = await pollUntilCompletion(modelRuntime, inferenceId, pollModelId, route);

    if (!pollResult) {
      throw new Error('Polling completed but no video URL returned');
    }

    claimedByThisWorker = await AsyncTaskModel.claimVideoCompletion(db, asyncTaskId);
    if (!claimedByThisWorker) {
      log('Video task already claimed or finalized, skipping polling result: %s', asyncTaskId);
      return;
    }

    log('Video polling succeeded for task: %s, processing video...', asyncTaskId);

    const processResult = await videoService.processVideoForGeneration(pollResult.videoUrl, {
      headers: pollResult.headers,
    });

    const batch = await db.query.generationBatches.findFirst({
      where: (batches, { eq }) => eq(batches.id, generationBatchId),
    });

    const asset: VideoGenerationAsset = {
      coverUrl: processResult.coverKey,
      duration: processResult.duration,
      height: processResult.height,
      interactionId: inferenceId,
      originalUrl: pollResult.videoUrl.startsWith('data:') ? undefined : pollResult.videoUrl,
      previousGenerationId,
      thumbnailUrl: processResult.thumbnailKey,
      type: 'video',
      url: processResult.videoKey,
      width: processResult.width,
    };

    await generationModel.createAssetAndFile(
      generationId,
      asset,
      buildVideoGenerationFilePayload({
        generationId,
        processResult,
        prompt: batch?.prompt,
      }),
      FileSource.VideoGeneration,
    );

    const duration = Date.now() - asyncTaskCreatedAt.getTime();

    await asyncTaskModel.update(asyncTaskId, {
      duration,
      status: AsyncTaskStatus.Success,
    });

    try {
      await notifyVideoCompleted({
        generationBatchId,
        model,
        prompt: batch?.prompt ?? '',
        topicId: generationTopicId,
        userId,
        workspaceId,
      });
    } catch (error) {
      console.error('[video-background-polling] Video completion notification failed:', error);
    }

    try {
      const { resolvedModelId } = await resolveBusinessModelMapping(provider, model);
      await chargeAfterGenerate({
        computePriceParams: {
          duration: (batch?.config as RuntimeVideoGenParams | undefined)?.duration,
          generateAudio: (batch?.config as RuntimeVideoGenParams | undefined)?.generateAudio,
          resolution: (batch?.config as RuntimeVideoGenParams | undefined)?.resolution,
        },
        latency: duration,
        metadata: {
          ...spendOrigin,
          asyncTaskId,
          generationBatchId,
          topicId: generationTopicId,
          ...buildMappedBusinessModelFields({
            provider,
            requestedModelId: resolvedModelId === model ? undefined : model,
            resolvedModelId,
          }),
        },
        model: resolvedModelId,
        prechargeResult,
        provider,
        usage: pollResult.usage ?? measureVideoOutputUsage(resolvedModelId, processResult),
        userId,
        workspaceId,
      });
    } catch (error) {
      console.error('[video-background-polling] Video completion charge failed:', error);
    }

    log('Video processing completed successfully for task: %s', asyncTaskId);

    console.info(
      `[video] result stored asyncTask=${asyncTaskId} inferenceId=${inferenceId} provider=${provider} routerId=${route?.routerId ?? '-'} durationMs=${duration} mode=${pollingIsFallback ? 'fallback-polling' : 'polling'}`,
    );
  } catch (error) {
    // Always visible regardless of DEBUG: this is the terminal "why the video
    // never showed up" reason, not routine per-attempt tracing — matches the
    // console.error already used for the infra-level catch in the caller
    // (routers/lambda/video/index.ts).
    console.error(
      `[video] polling failed asyncTask=${asyncTaskId} inferenceId=${inferenceId} provider=${provider} routerId=${route?.routerId ?? '-'} fallback=${Boolean(pollingIsFallback)}:`,
      error,
    );

    // A fallback poller runs next to a provider callback that may still arrive, so it
    // must not decide the outcome from its own transport failures or from running out
    // of budget: doing so would fail a task whose video is generated and merely
    // delivered through the other channel. Only an authoritative upstream failure
    // finalizes it, and the video task deadline is the backstop for the rest.
    if (pollingIsFallback && !(error instanceof VideoGenerationFailedError)) {
      console.warn(
        `[video] fallback polling inconclusive asyncTask=${asyncTaskId} inferenceId=${inferenceId}; leaving the task for the provider callback`,
      );
      return;
    }

    const asyncTaskModel = new AsyncTaskModel(db, userId, workspaceId);
    if (!claimedByThisWorker) {
      claimedByThisWorker = await AsyncTaskModel.claimVideoCompletion(db, asyncTaskId);
      if (!claimedByThisWorker) {
        log('Video task failure already handled by another worker: %s', asyncTaskId);
        return;
      }
    }

    const providerContentPolicyMessage = await getProviderContentPolicyErrorMessage({
      error,
      provider,
      trigger: RequestTrigger.Video,
      userId,
    });
    if (providerContentPolicyMessage) {
      try {
        await trackProviderContentPolicyViolation({
          error,
          model,
          provider,
          trigger: 'video-polling',
          userId,
        });
      } catch (trackError) {
        log('Failed to track provider content policy violation: %O', trackError);
      }
    }
    await asyncTaskModel.update(asyncTaskId, {
      error: new AsyncTaskError(
        providerContentPolicyMessage
          ? AsyncTaskErrorType.ProviderContentModeration
          : AsyncTaskErrorType.ServerError,
        providerContentPolicyMessage ??
          'Background polling failed: ' +
            (error instanceof Error ? error.message : 'Unknown error'),
      ),
      status: AsyncTaskStatus.Error,
    });

    console.error(
      `[video] polling finalized as error asyncTask=${asyncTaskId} inferenceId=${inferenceId} provider=${provider} type=${providerContentPolicyMessage ? 'content-policy' : 'server'}`,
    );

    try {
      const { resolvedModelId } = await resolveBusinessModelMapping(provider, model);
      await chargeAfterGenerate({
        isError: true,
        metadata: {
          ...spendOrigin,
          asyncTaskId,
          generationBatchId,
          topicId: generationTopicId,
          ...buildMappedBusinessModelFields({
            provider,
            requestedModelId: resolvedModelId === model ? undefined : model,
            resolvedModelId,
          }),
        },
        model: resolvedModelId,
        prechargeResult,
        provider,
        userId,
        workspaceId,
      });
    } catch (refundError) {
      console.error('[video-background-polling] Video generation refund failed:', refundError);
    }
  }
}

async function pollUntilCompletion(
  modelRuntime: any,
  inferenceId: string,
  model: string,
  route?: VideoGenerationRoute,
): Promise<{
  headers?: Record<string, string>;
  usage?: VideoGenerationUsage;
  videoUrl: string;
} | null> {
  const pollingInterval = 5000;
  // Budget on wall-clock time, not on an attempt count: the provider query itself
  // can block, and a count of intervals silently extends the real wait past the
  // deadline it was derived from.
  const startedAt = Date.now();
  const deadline = startedAt + VIDEO_GENERATION_POLL_TIMEOUT;
  const budgetSec = Math.round(VIDEO_GENERATION_POLL_TIMEOUT / 1000);
  let attempt = 0;

  while (Date.now() < deadline) {
    attempt += 1;
    const elapsedSec = Math.round((Date.now() - startedAt) / 1000);

    try {
      // Log the raw result (not just the status label) so a "failed" from the
      // upstream provider is diagnosable from this line alone, and the elapsed
      // time so a mid-flight platform kill (no further lines after this one)
      // can be told apart from a genuine multi-minute in-progress wait.
      log(
        'Polling attempt %d for task: %s (elapsed %ds/%ds)',
        attempt,
        inferenceId,
        elapsedSec,
        budgetSec,
      );

      const result = await withTimeout<PollVideoStatusResult>(
        modelRuntime.handlePollVideoStatus(inferenceId, model, route),
        STATUS_QUERY_TIMEOUT,
        `Video status query did not answer within ${STATUS_QUERY_TIMEOUT / 1000}s`,
      );

      log('Poll result for task %s at %ds: %O', inferenceId, elapsedSec, result);

      if (result.status === 'success') {
        log('Video generation succeeded for task: %s after %ds', inferenceId, elapsedSec);
        return { headers: result.headers, usage: result.usage, videoUrl: result.videoUrl };
      }

      if (result.status === 'failed') {
        throw new VideoGenerationFailedError(`Video generation failed: ${result.error}`);
      }

      await sleep(pollingInterval);
    } catch (error) {
      // An explicit upstream failure ends the wait; everything else (network resets,
      // provider 429/5xx, a single query that timed out) is retried on the normal
      // interval until the budget is exhausted, which then reports the timeout.
      if (error instanceof VideoGenerationFailedError) {
        throw error;
      }

      log(
        'Polling attempt %d failed for task: %s at %ds: %O',
        attempt,
        inferenceId,
        elapsedSec,
        error,
      );
      await sleep(pollingInterval);
    }
  }

  throw new Error(`Video generation timeout after ${budgetSec}s of polling`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

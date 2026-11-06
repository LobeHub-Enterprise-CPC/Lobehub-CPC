import type {
  MemoryExtractionJob,
  MemoryExtractionResult,
  PersistedMemoryResult,
} from '@lobechat/memory-user-memory';
import { SpanStatusCode } from '@lobechat/observability-otel/api';
import {
  layerEntriesHistogram,
  processedDurationHistogram,
  processedSourceCounter,
  tracer,
} from '@lobechat/observability-otel/modules/memory-user-memory';
import { attributesCommon } from '@lobechat/observability-otel/node';

import type { getServerDB } from '@/database/server';
import type { LobeChatDatabase } from '@/database/type';
import { LayersEnum } from '@/types/userMemory';

import { LAYER_LABEL_MAP } from './constants';
import type { MemoryExtractionExecutorContext } from './context';
import type { MemoryExtractionTaskErrorItem } from './errors';
import { makeTaskErrorItem, MemoryExtractionAggregateError } from './errors';
import type { PreparedLayer, ResolvedMemoryServiceConfig, RuntimeBundle } from './types';

export function recordJobMetrics(
  job: MemoryExtractionJob,
  status: 'completed' | 'failed',
  durationMs: number,
) {
  processedSourceCounter.add(1, {
    source: job.source,
    status,
    user_id: job.userId,
    ...attributesCommon(),
  });
  processedDurationHistogram.record(durationMs, {
    source: job.source,
    user_id: job.userId,
    ...attributesCommon(),
  });
}

export function recordLayerEntries(job: MemoryExtractionJob, layer: LayersEnum, count: number) {
  layerEntriesHistogram.record(count, {
    layer: LAYER_LABEL_MAP[layer],
    source: job.source,
    user_id: job.userId,
    ...attributesCommon(),
  });
}

export function normalizeLayerError(
  layer: LayersEnum,
  stage: 'extract' | 'persist',
  error: unknown,
) {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`[${stage}] ${LAYER_LABEL_MAP[layer]}: ${message}`);
}

/**
 * Writes a segment's extraction all at once. Layers are validated and embedded first, outside any
 * transaction; then every layer's memories and `commit` (the topic watermark) are written in one
 * transaction. A failure anywhere leaves nothing behind, so the retry that follows cannot write
 * the segment's memories twice; once the watermark is committed the segment is never redone.
 */
export async function persistExtraction(
  ctx: MemoryExtractionExecutorContext,
  job: MemoryExtractionJob,
  messageIds: string[],
  extraction: MemoryExtractionResult,
  runtimes: RuntimeBundle,
  memoryServiceConfig: ResolvedMemoryServiceConfig,
  db: Awaited<ReturnType<typeof getServerDB>>,
  commit?: (tx: LobeChatDatabase, result: PersistedMemoryResult) => Promise<void>,
): Promise<PersistedMemoryResult> {
  const errors: MemoryExtractionTaskErrorItem[] = [];
  const appendError = (
    layer: LayersEnum,
    stage: 'extract' | 'persist',
    error: unknown,
    options?: { memoryIndex?: number; preview?: unknown },
  ) => {
    errors.push(
      makeTaskErrorItem(stage, ctx.normalizeLayerError(layer, stage, error), {
        layer: LAYER_LABEL_MAP[layer],
        memoryIndex: options?.memoryIndex,
        preview: options?.preview,
        sourceId: job.sourceId,
        sourceType: job.source,
      }),
    );
  };
  const logPersistError = (layer: LayersEnum, error: unknown) =>
    console.error(
      '[memory-extraction] failed to persist memories',
      error,
      'layer:',
      layer,
      'source:',
      job.source,
      'sourceId:',
      job.sourceId,
      'userId:',
      job.userId,
    );

  const prepared: { layer: LayersEnum; write: PreparedLayer['write'] }[] = [];
  const prepareWithSpan = async (
    layer: LayersEnum,
    prepare: () => Promise<PreparedLayer>,
  ): Promise<void> => {
    const attributes = {
      layer: LAYER_LABEL_MAP[layer],
      source: job.source,
      source_id: job.sourceId,
      user_id: job.userId,
      ...attributesCommon(),
    };

    await tracer.startActiveSpan(
      `Memory User Memory: Prepare ${LAYER_LABEL_MAP[layer]}`,
      { attributes },
      async (span) => {
        try {
          prepared.push({ layer, write: (await prepare()).write });
          span.setStatus({ code: SpanStatusCode.OK });
        } catch (error) {
          appendError(layer, 'persist', error);
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message:
              error instanceof Error ? error.message : 'Failed to prepare extracted memories',
          });
          span.recordException(error as Error);
          logPersistError(layer, error);
        } finally {
          span.end();
        }
      },
    );
  };

  const embedding = [
    runtimes.embeddings,
    memoryServiceConfig.modelConfig.embeddingsModel,
    memoryServiceConfig.embeddingContextLimit,
  ] as const;
  const { activity, context, experience, identity, preference } = extraction.outputs;

  if (activity?.error) appendError(LayersEnum.Activity, 'extract', activity.error);
  if (activity?.data) {
    const data = activity.data;
    await prepareWithSpan(LayersEnum.Activity, () =>
      ctx.prepareActivityMemories(job, messageIds, data, ...embedding),
    );
  }
  if (context?.error) appendError(LayersEnum.Context, 'extract', context.error);
  if (context?.data) {
    const data = context.data;
    await prepareWithSpan(LayersEnum.Context, () =>
      ctx.prepareContextMemories(job, messageIds, data, ...embedding),
    );
  }
  if (experience?.error) appendError(LayersEnum.Experience, 'extract', experience.error);
  if (experience?.data) {
    const data = experience.data;
    await prepareWithSpan(LayersEnum.Experience, () =>
      ctx.prepareExperienceMemories(job, messageIds, data, ...embedding),
    );
  }
  if (preference?.error) appendError(LayersEnum.Preference, 'extract', preference.error);
  if (preference?.data) {
    const data = preference.data;
    await prepareWithSpan(LayersEnum.Preference, () =>
      ctx.preparePreferenceMemories(job, messageIds, data, ...embedding),
    );
  }
  if (identity?.error) appendError(LayersEnum.Identity, 'extract', identity.error);
  if (identity?.data) {
    const data = identity.data;
    await prepareWithSpan(LayersEnum.Identity, () =>
      ctx.prepareIdentityMemories(job, messageIds, data, ...embedding),
    );
  }

  const aggregate = () =>
    new MemoryExtractionAggregateError(
      `Memory extraction encountered layer errors: ${errors.map((error) => error.message).join('; ')}`,
      errors,
    );
  // Nothing has been written yet: the whole segment is retried.
  if (errors.length) throw aggregate();

  let writing: LayersEnum | undefined;
  let result: PersistedMemoryResult;
  try {
    result = await db.transaction(async (tx) => {
      const createdIds: string[] = [];
      const layers: PersistedMemoryResult['layers'] = {};
      for (const { layer, write } of prepared) {
        writing = layer;
        const ids = await write(tx as LobeChatDatabase);
        createdIds.push(...ids);
        layers[layer] = ids.length;
      }
      writing = undefined;

      const written = { createdIds, layers };
      await commit?.(tx as LobeChatDatabase, written);
      return written;
    });
  } catch (error) {
    if (writing === undefined) throw error;
    appendError(writing, 'persist', error);
    logPersistError(writing, error);
    throw aggregate();
  }

  for (const [layer, count] of Object.entries(result.layers)) {
    ctx.recordLayerEntries(job, layer as LayersEnum, count);
  }
  return result;
}

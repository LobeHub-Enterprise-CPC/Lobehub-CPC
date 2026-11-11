import { and, count, eq, inArray } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

import { asyncTasks, files, knowledgeBaseFiles } from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';
import { notTrashed } from '@/database/utils/softDelete';

import { deriveStatus, isProcessingStatus, toTaskState } from './status';

/** The parsing and the embedding task of a file, joined onto `files` by id. */
export const chunkTask = alias(asyncTasks, 'chunk_task');
export const embeddingTask = alias(asyncTasks, 'embedding_task');

export interface KbFileCounts {
  failedCount: number;
  fileCount: number;
  processingCount: number;
}

/**
 * Files per knowledge base with how many are still being processed and how many failed.
 * Trashed files are not counted. Grouped by task status pair, so it stays one small query
 * however many files there are.
 */
export const countKnowledgeBaseFiles = async (
  db: LobeChatDatabase,
  knowledgeBaseIds: string[],
): Promise<Record<string, KbFileCounts>> => {
  const result: Record<string, KbFileCounts> = {};
  for (const id of knowledgeBaseIds)
    result[id] = { failedCount: 0, fileCount: 0, processingCount: 0 };
  if (knowledgeBaseIds.length === 0) return result;

  const rows = await db
    .select({
      chunkStatus: chunkTask.status,
      embeddingStatus: embeddingTask.status,
      knowledgeBaseId: knowledgeBaseFiles.knowledgeBaseId,
      total: count(),
    })
    .from(knowledgeBaseFiles)
    .innerJoin(files, eq(files.id, knowledgeBaseFiles.fileId))
    .leftJoin(chunkTask, eq(chunkTask.id, files.chunkTaskId))
    .leftJoin(embeddingTask, eq(embeddingTask.id, files.embeddingTaskId))
    .where(
      and(
        inArray(knowledgeBaseFiles.knowledgeBaseId, knowledgeBaseIds),
        notTrashed(files.isDeleted),
      ),
    )
    .groupBy(knowledgeBaseFiles.knowledgeBaseId, chunkTask.status, embeddingTask.status);

  for (const row of rows) {
    const counts = result[row.knowledgeBaseId];
    const { status } = deriveStatus(toTaskState(row.chunkStatus), toTaskState(row.embeddingStatus));
    counts.fileCount += row.total;
    if (status === 'error') counts.failedCount += row.total;
    else if (isProcessingStatus(status)) counts.processingCount += row.total;
  }

  return result;
};

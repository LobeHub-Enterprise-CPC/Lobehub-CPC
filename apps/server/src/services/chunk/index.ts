import { type LobeChatDatabase } from '@lobechat/database';

import { FILE_PARSE_SIZE_LIMIT_ERROR_MESSAGE, MAX_FILE_PARSE_SIZE } from '@/const/file';
import { AsyncTaskModel } from '@/database/models/asyncTask';
import { FileModel } from '@/database/models/file';
import { getChunkingLoaderType } from '@/libs/document-loaders/loaderType';
import { type ChunkContentParams } from '@/server/modules/ContentChunk';
import { ContentChunk } from '@/server/modules/ContentChunk';
import { getDirectDeliveryClient } from '@/server/modules/Hatchet/directDelivery';
import { FILE_WORKFLOW_PATH } from '@/server/modules/Hatchet/fileRoute';
import { buildTenantCallbackUrl } from '@/server/modules/Tenant/callbackUrl';
import {
  AsyncTaskError,
  AsyncTaskErrorType,
  AsyncTaskStatus,
  AsyncTaskType,
} from '@/types/asyncTask';

/** Redeliveries of a file job whose attempt failed before the task started. */
export const FILE_JOB_RETRIES = 2;

export class ChunkService {
  private userId: string;
  private workspaceId?: string;
  private chunkClient: ContentChunk;
  private fileModel: FileModel;
  private asyncTaskModel: AsyncTaskModel;

  constructor(serverDB: LobeChatDatabase, userId: string, workspaceId?: string) {
    this.userId = userId;
    this.workspaceId = workspaceId;

    this.chunkClient = new ContentChunk();

    this.fileModel = new FileModel(serverDB, userId, workspaceId);
    this.asyncTaskModel = new AsyncTaskModel(serverDB, userId, workspaceId);
  }

  async chunkContent(params: ChunkContentParams) {
    return this.chunkClient.chunkContent(params);
  }

  async asyncEmbeddingFileChunks(fileId: string) {
    const result = await this.fileModel.findById(fileId);

    if (!result) return;

    // 1. create a asyncTaskId
    const asyncTaskId = await this.asyncTaskModel.create({
      status: AsyncTaskStatus.Pending,
      type: AsyncTaskType.Embedding,
    });

    await this.fileModel.update(fileId, { embeddingTaskId: asyncTaskId });

    await this.publishFileJob('embed', fileId, asyncTaskId);

    return asyncTaskId;
  }

  /**
   * parse file to chunks with async task
   */
  async asyncParseFileToChunks(fileId: string, skipExist?: boolean) {
    const result = await this.fileModel.findById(fileId);

    if (!result) return;

    // skip if already exist chunk tasks
    if (skipExist && result.chunkTaskId) return;

    // No chunking loader can parse this format (e.g. `.dwg`): creating a task would only
    // surface a retryable "Chunking failed" for a limitation retrying cannot fix.
    if (!getChunkingLoaderType(result.name)) return;

    // 1. create a asyncTaskId
    const asyncTaskId = await this.asyncTaskModel.create({
      // Queued until a file job worker takes it.
      status: result.size > MAX_FILE_PARSE_SIZE ? AsyncTaskStatus.Error : AsyncTaskStatus.Pending,
      type: AsyncTaskType.Chunking,
    });

    await this.fileModel.update(fileId, { chunkTaskId: asyncTaskId });

    if (result.size > MAX_FILE_PARSE_SIZE) {
      await this.asyncTaskModel.update(asyncTaskId, {
        error: new AsyncTaskError(
          AsyncTaskErrorType.FileTooLargeToParse,
          FILE_PARSE_SIZE_LIMIT_ERROR_MESSAGE,
        ),
        status: AsyncTaskStatus.Error,
      });

      return asyncTaskId;
    }

    await this.publishFileJob('parse', fileId, asyncTaskId);

    return asyncTaskId;
  }

  /**
   * Queue the work for a file task. It is delivered to `/api/workflows/file/{job}`: by a
   * file job worker in queue mode, where its slots bound how many files a process works
   * on, and by this process in local mode. The task stays `pending` until then.
   */
  private async publishFileJob(job: 'embed' | 'parse', fileId: string, taskId: string) {
    try {
      await getDirectDeliveryClient().publishJSON({
        body: { fileId, taskId, userId: this.userId, workspaceId: this.workspaceId },
        deduplicationId: `file-${job}:${taskId}`,
        retries: FILE_JOB_RETRIES,
        url: buildTenantCallbackUrl(`${FILE_WORKFLOW_PATH}${job}`),
      });
    } catch (e) {
      console.error(`[ChunkService] failed to queue the ${job} job of file ${fileId}:`, e);

      await this.asyncTaskModel.update(taskId, {
        error: new AsyncTaskError(
          AsyncTaskErrorType.TaskTriggerError,
          'Failed to queue the file task. Please try again later.',
        ),
        status: AsyncTaskStatus.Error,
      });
    }
  }
}

// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AsyncTaskError,
  AsyncTaskErrorType,
  AsyncTaskStatus,
  AsyncTaskType,
} from '@/types/asyncTask';

import { ChunkService } from './index';

const {
  mockAsyncTaskModelCreate,
  mockAsyncTaskModelUpdate,
  mockChunkContent,
  mockFileModelFindById,
  mockFileModelUpdate,
  mockPublishJSON,
} = vi.hoisted(() => ({
  mockAsyncTaskModelCreate: vi.fn(),
  mockAsyncTaskModelUpdate: vi.fn(),
  mockChunkContent: vi.fn(),
  mockFileModelFindById: vi.fn(),
  mockFileModelUpdate: vi.fn(),
  mockPublishJSON: vi.fn(),
}));

vi.mock('@/database/models/asyncTask', () => ({
  AsyncTaskModel: vi.fn(function () {
    return {
      create: mockAsyncTaskModelCreate,
      update: mockAsyncTaskModelUpdate,
    };
  }),
}));

vi.mock('@/database/models/file', () => ({
  FileModel: vi.fn(function () {
    return {
      findById: mockFileModelFindById,
      update: mockFileModelUpdate,
    };
  }),
}));

vi.mock('@/server/modules/ContentChunk', () => ({
  ContentChunk: vi.fn(function () {
    return {
      chunkContent: mockChunkContent,
    };
  }),
}));

vi.mock('@/server/modules/Hatchet/directDelivery', () => ({
  getDirectDeliveryClient: () => ({ publishJSON: mockPublishJSON }),
}));

vi.mock('@/server/modules/Tenant/callbackUrl', () => ({
  buildTenantCallbackUrl: (path: string) => `http://internal/orgs/acme${path}`,
}));

describe('ChunkService', () => {
  const userId = 'test-user-id';
  const mockDb = {} as any;
  let service: ChunkService;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();

    mockAsyncTaskModelCreate.mockResolvedValue('task-1');
    mockAsyncTaskModelUpdate.mockResolvedValue(undefined);
    mockChunkContent.mockResolvedValue({ chunks: [{ id: 'chunk-1', index: 0, text: 'chunk' }] });
    mockFileModelFindById.mockResolvedValue({ id: 'file-1', name: 'file-1.pdf' });
    mockFileModelUpdate.mockResolvedValue(undefined);
    mockPublishJSON.mockResolvedValue({ messageId: 'run_1' });

    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(function () {});
    service = new ChunkService(mockDb, userId);
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  describe('chunkContent', () => {
    it('should delegate chunking to ContentChunk', async () => {
      const params = {
        content: new Uint8Array([1, 2, 3]),
        filename: 'test.md',
        fileType: 'text/markdown',
      };

      const result = await service.chunkContent(params);

      expect(mockChunkContent).toHaveBeenCalledWith(params);
      expect(result).toEqual({ chunks: [{ id: 'chunk-1', index: 0, text: 'chunk' }] });
    });
  });

  describe('asyncEmbeddingFileChunks', () => {
    it('should return undefined when file is not found', async () => {
      mockFileModelFindById.mockResolvedValue(undefined);

      await expect(service.asyncEmbeddingFileChunks('missing-file')).resolves.toBeUndefined();

      expect(mockAsyncTaskModelCreate).not.toHaveBeenCalled();
      expect(mockFileModelUpdate).not.toHaveBeenCalled();
      expect(mockPublishJSON).not.toHaveBeenCalled();
    });

    it('creates a pending task and queues the embedding job for a file worker', async () => {
      const taskId = await service.asyncEmbeddingFileChunks('file-1');

      expect(taskId).toBe('task-1');
      expect(mockAsyncTaskModelCreate).toHaveBeenCalledWith({
        status: AsyncTaskStatus.Pending,
        type: AsyncTaskType.Embedding,
      });
      expect(mockFileModelUpdate).toHaveBeenCalledWith('file-1', { embeddingTaskId: 'task-1' });
      expect(mockPublishJSON).toHaveBeenCalledWith({
        body: { fileId: 'file-1', taskId: 'task-1', userId, workspaceId: undefined },
        deduplicationId: 'file-embed:task-1',
        retries: 2,
        url: 'http://internal/orgs/acme/api/workflows/file/embed',
      });
      expect(mockAsyncTaskModelUpdate).not.toHaveBeenCalled();
    });

    it('marks the task failed when the job cannot be queued', async () => {
      mockPublishJSON.mockRejectedValue(new Error('engine unavailable'));

      const taskId = await service.asyncEmbeddingFileChunks('file-1');

      expect(taskId).toBe('task-1');
      expect(mockAsyncTaskModelUpdate).toHaveBeenCalledTimes(1);
      expect(mockAsyncTaskModelUpdate).toHaveBeenCalledWith('task-1', {
        error: new AsyncTaskError(
          AsyncTaskErrorType.TaskTriggerError,
          'Failed to queue the file task. Please try again later.',
        ),
        status: AsyncTaskStatus.Error,
      });
    });
  });

  describe('asyncParseFileToChunks', () => {
    it('should return undefined when file is not found', async () => {
      mockFileModelFindById.mockResolvedValue(undefined);

      await expect(service.asyncParseFileToChunks('missing-file')).resolves.toBeUndefined();

      expect(mockAsyncTaskModelCreate).not.toHaveBeenCalled();
      expect(mockFileModelUpdate).not.toHaveBeenCalled();
      expect(mockPublishJSON).not.toHaveBeenCalled();
    });

    it('should create an error task for files larger than the in-memory parser limit', async () => {
      mockFileModelFindById.mockResolvedValue({
        id: 'large-file',
        name: 'large-file.pdf',
        size: 64 * 1024 * 1024 + 1,
      });

      await expect(service.asyncParseFileToChunks('large-file')).resolves.toBe('task-1');

      expect(mockAsyncTaskModelCreate).toHaveBeenCalledWith({
        status: AsyncTaskStatus.Error,
        type: AsyncTaskType.Chunking,
      });
      expect(mockFileModelUpdate).toHaveBeenCalledWith('large-file', { chunkTaskId: 'task-1' });
      expect(mockAsyncTaskModelUpdate).toHaveBeenCalledWith('task-1', {
        error: new AsyncTaskError(
          AsyncTaskErrorType.FileTooLargeToParse,
          'Files larger than 67108864 bytes cannot be parsed in memory',
        ),
        status: AsyncTaskStatus.Error,
      });
      expect(mockPublishJSON).not.toHaveBeenCalled();
    });

    // https://github.com/lobehub/lobehub/issues/19620
    it('should not create a chunking task for a format no chunking loader can parse', async () => {
      mockFileModelFindById.mockResolvedValue({
        id: 'dwg-file',
        name: 'floor-plan.dwg',
        size: 1024,
      });

      await expect(service.asyncParseFileToChunks('dwg-file')).resolves.toBeUndefined();

      expect(mockAsyncTaskModelCreate).not.toHaveBeenCalled();
      expect(mockFileModelUpdate).not.toHaveBeenCalled();
      expect(mockPublishJSON).not.toHaveBeenCalled();
    });

    it('should skip creating a new task when skipExist is true and task already exists', async () => {
      mockFileModelFindById.mockResolvedValue({ chunkTaskId: 'existing-task', id: 'file-1' });

      await expect(service.asyncParseFileToChunks('file-1', true)).resolves.toBeUndefined();

      expect(mockAsyncTaskModelCreate).not.toHaveBeenCalled();
      expect(mockFileModelUpdate).not.toHaveBeenCalled();
      expect(mockPublishJSON).not.toHaveBeenCalled();
    });

    it('creates a pending task and queues the parse job for a file worker', async () => {
      const taskId = await new ChunkService(mockDb, userId, 'ws-1').asyncParseFileToChunks(
        'file-1',
      );

      expect(taskId).toBe('task-1');
      // Queued, not processing: nothing has started working on the file yet.
      expect(mockAsyncTaskModelCreate).toHaveBeenCalledWith({
        status: AsyncTaskStatus.Pending,
        type: AsyncTaskType.Chunking,
      });
      expect(mockFileModelUpdate).toHaveBeenCalledWith('file-1', { chunkTaskId: 'task-1' });
      expect(mockPublishJSON).toHaveBeenCalledWith({
        body: { fileId: 'file-1', taskId: 'task-1', userId, workspaceId: 'ws-1' },
        deduplicationId: 'file-parse:task-1',
        retries: 2,
        url: 'http://internal/orgs/acme/api/workflows/file/parse',
      });
      expect(mockAsyncTaskModelUpdate).not.toHaveBeenCalled();
    });

    it('marks the task failed when the job cannot be queued', async () => {
      mockPublishJSON.mockRejectedValue(new Error('engine unavailable'));

      const taskId = await service.asyncParseFileToChunks('file-1');

      expect(taskId).toBe('task-1');
      expect(mockAsyncTaskModelUpdate).toHaveBeenCalledWith('task-1', {
        error: new AsyncTaskError(
          AsyncTaskErrorType.TaskTriggerError,
          'Failed to queue the file task. Please try again later.',
        ),
        status: AsyncTaskStatus.Error,
      });
    });
  });
});

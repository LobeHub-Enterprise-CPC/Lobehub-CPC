// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockFindDeletableFilesByTopicId = vi.fn();
const mockDeleteUnreferenced = vi.fn();
const mockPurge = vi.fn();
const mockBusinessFileExternalReferenceGuard = vi.fn();

vi.mock('@/business/server/lambda-routers/file', () => ({
  businessFileExternalReferenceGuard: mockBusinessFileExternalReferenceGuard,
}));

vi.mock('@/config/db', () => ({ serverDBEnv: { REMOVE_GLOBAL_FILE: true } }));

vi.mock('@/database/models/file', () => ({
  FileModel: vi.fn(function () {
    return {
      deleteUnreferenced: mockDeleteUnreferenced,
      findDeletableFilesByTopicId: mockFindDeletableFilesByTopicId,
    };
  }),
}));

vi.mock('@/database/models/topic', () => ({
  TopicModel: vi.fn(function () {
    return { purge: mockPurge };
  }),
}));

const { topicHandler } = await import('./topic');

describe('topic trash purge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('retains externally referenced files and deletes only returned S3 objects after purge', async () => {
    const deleteFiles = vi.fn();
    mockFindDeletableFilesByTopicId.mockResolvedValue(['file-z', 'file-a']);
    mockPurge.mockResolvedValue(['topic-1']);
    mockDeleteUnreferenced
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ url: 's3://unreferenced' });

    await topicHandler.purge(
      { db: {}, fileService: { deleteFiles }, userId: 'user-1' } as any,
      { meta: { removeFiles: true }, resourceId: 'topic-1' } as any,
      [],
    );

    expect(mockPurge).toHaveBeenCalledWith(['topic-1']);
    expect(mockDeleteUnreferenced).toHaveBeenNthCalledWith(
      1,
      'file-a',
      { removeGlobalFile: true },
      mockBusinessFileExternalReferenceGuard,
    );
    expect(mockDeleteUnreferenced).toHaveBeenNthCalledWith(
      2,
      'file-z',
      { removeGlobalFile: true },
      mockBusinessFileExternalReferenceGuard,
    );
    expect(mockPurge.mock.invocationCallOrder[0]).toBeLessThan(
      mockDeleteUnreferenced.mock.invocationCallOrder[0],
    );
    expect(deleteFiles).toHaveBeenCalledWith(['s3://unreferenced']);
  });
});

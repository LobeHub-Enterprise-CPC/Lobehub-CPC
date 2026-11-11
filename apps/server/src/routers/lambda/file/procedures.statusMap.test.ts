// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { AsyncTaskStatus } from '@/types/asyncTask';

import { getKnowledgeItemStatusMap } from './procedures';

vi.mock('@/business/server/trpc-middlewares/workspaceAuth', () => ({
  wsCompatProcedure: { use: () => ({ use: () => ({}) }) },
}));
vi.mock('@/libs/trpc/lambda/middleware', () => ({ serverDatabase: {} }));
vi.mock('@/database/models/asyncTask', () => ({ AsyncTaskModel: vi.fn() }));
vi.mock('@/database/models/chunk', () => ({ ChunkModel: vi.fn() }));
vi.mock('@/database/models/document', () => ({ DocumentModel: vi.fn() }));
vi.mock('@/database/models/file', () => ({ FileModel: vi.fn() }));
vi.mock('@/database/models/knowledgeBase', () => ({ KnowledgeBaseModel: vi.fn() }));
vi.mock('@/database/repositories/knowledge', () => ({ KnowledgeRepo: vi.fn() }));
vi.mock('@/server/services/document', () => ({ DocumentService: vi.fn() }));
vi.mock('@/server/services/file', () => ({ FileService: vi.fn() }));
vi.mock('@/server/services/fileUpload', () => ({ FileUploadService: vi.fn() }));
vi.mock('../_helpers/knowledgeBaseAccess', () => ({
  assertContentsNotInRestrictedKnowledgeBase: vi.fn(),
}));

describe('getKnowledgeItemStatusMap', () => {
  it('counts the chunks of a file listed under its derived document id', async () => {
    const countByFileIds = vi.fn().mockResolvedValue([
      { count: 12, id: 'file_1' },
      { count: 3, id: 'file_2' },
    ]);
    const findByIds = vi
      .fn()
      .mockResolvedValue([{ error: null, id: 'chunk_1', status: AsyncTaskStatus.Success }]);

    const statuses = await getKnowledgeItemStatusMap(
      { asyncTaskModel: { findByIds }, chunkModel: { countByFileIds } } as any,
      [
        // Listed under the document parsed from it: chunks still belong to the file.
        { chunkTaskId: 'chunk_1', fileId: 'file_1', id: 'docs_1' },
        { id: 'file_2' },
      ],
    );

    expect(countByFileIds).toHaveBeenCalledWith(['file_1', 'file_2']);
    expect(statuses.get('docs_1')).toMatchObject({
      chunkCount: 12,
      chunkingStatus: AsyncTaskStatus.Success,
      id: 'docs_1',
    });
    expect(statuses.get('file_2')).toMatchObject({ chunkCount: 3, id: 'file_2' });
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { fileService } from '@/services/file';

import { loadMoveTargetFolders } from './loadMoveTargetFolders';

vi.mock('@/services/file', () => ({ fileService: { getKnowledgeItems: vi.fn() } }));

describe('folder move target directory boundary', () => {
  beforeEach(() => vi.resetAllMocks());
  it('loads subsequent pages and addresses nested folders by database ID instead of route slug', async () => {
    vi.mocked(fileService.getKnowledgeItems)
      .mockResolvedValueOnce({
        hasMore: true,
        items: [
          { id: 'docs_1', slug: 'short-route', name: 'B', fileType: 'custom/folder' },
          { id: 'file_1', name: 'not a folder', fileType: 'text/plain' },
        ],
      } as never)
      .mockResolvedValueOnce({
        hasMore: false,
        items: [{ id: 'docs_2', slug: 'another-route', name: 'A', fileType: 'custom/folder' }],
      } as never);
    const folders = await loadMoveTargetFolders('kb_1', 'docs_parent');
    expect(folders).toEqual([
      { id: 'docs_2', name: 'A' },
      { id: 'docs_1', name: 'B' },
    ]);
    expect(fileService.getKnowledgeItems).toHaveBeenLastCalledWith(
      expect.objectContaining({
        knowledgeBaseId: 'kb_1',
        parentId: 'docs_parent',
        offset: 2,
      }),
    );
  });
  it('propagates a folder query failure instead of presenting an empty directory', async () => {
    vi.mocked(fileService.getKnowledgeItems).mockRejectedValueOnce(
      new Error('directory unavailable'),
    );
    await expect(loadMoveTargetFolders('kb_1', null)).rejects.toThrow('directory unavailable');
  });
});

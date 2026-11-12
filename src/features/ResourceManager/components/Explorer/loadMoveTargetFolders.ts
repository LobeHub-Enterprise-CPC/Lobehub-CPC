import { CUSTOM_FOLDER_FILE_TYPE } from '@lobechat/const';

import type { FolderTreeItem } from '@/features/ResourceManager/components/FolderTree';
import { fileService } from '@/services/file';

/** FolderTree uses its keys for child queries; move APIs require IDs, never route slugs. */
export const loadMoveTargetFolders = async (
  knowledgeBaseId: string | undefined,
  parentId: string | null,
): Promise<FolderTreeItem[]> => {
  const folders: FolderTreeItem[] = [];
  let offset = 0;
  while (true) {
    const response = await fileService.getKnowledgeItems({
      includeContentPreview: false,
      knowledgeBaseId,
      parentId,
      showFilesInKnowledgeBase: false,
      limit: 100,
      offset,
    });
    folders.push(
      ...response.items
        .filter((item) => item.fileType === CUSTOM_FOLDER_FILE_TYPE)
        .map((item) => ({ id: item.id, name: item.name })),
    );
    if (!response.hasMore) break;
    if (!response.items.length) throw new Error('Folder query did not advance');
    offset += response.items.length;
  }
  return folders.sort((a, b) => a.name.localeCompare(b.name));
};

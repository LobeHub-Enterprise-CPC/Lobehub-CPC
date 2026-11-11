import type { FileListItem } from '@lobechat/types';

import { useResourceManagerStore } from '@/features/ResourceManager/store';
import { isExplorerItemSelected } from '@/features/ResourceManager/store/selectors';
import { useFileStore } from '@/store/file';

import { useLibraryPermission } from './useLibraryPermission';

/** Directory actions and batch mutations need both the directory and every selected item. */
export const useLibrarySelectionPermission = () => {
  const permission = useLibraryPermission('edit_own_content');
  const [selectedIds, selectAllState] = useResourceManagerStore((s) => [
    s.selectedFileIds,
    s.selectAllState,
  ]);
  const hasReadOnly = useFileStore((s) =>
    (s.resourceList as FileListItem[]).some((item) => {
      if (!isExplorerItemSelected({ id: item.id, selectedIds, selectAllState })) return false;
      return item.enterpriseAccess && !['owner', 'edit'].includes(item.enterpriseAccess.level);
    }),
  );
  return { ...permission, allowed: permission.allowed && !hasReadOnly };
};

import { CUSTOM_FOLDER_FILE_TYPE } from '@lobechat/const';
import {
  Button,
  createModal,
  Flexbox,
  Icon,
  ModalFooter,
  toast,
  useModalContext,
} from '@lobehub/ui';
import { t as translate } from 'i18next';
import { FolderIcon } from 'lucide-react';
import { memo, useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useLibraryPermission } from '@/features/EnterpriseKnowledge/useLibraryPermission';
import { type FolderTreeItem } from '@/features/ResourceManager/components/FolderTree';
import FolderTree from '@/features/ResourceManager/components/FolderTree';
import { fileService } from '@/services/file';
import { useFileStore } from '@/store/file';
import { useTreeStore } from '@/store/tree';

interface MoveToFolderModalContentProps {
  fileId: string;
  knowledgeBaseId?: string;
}

const MoveToFolderModalContent = memo<MoveToFolderModalContentProps>(
  ({ fileId, knowledgeBaseId }) => {
    const { t } = useTranslation('components');
    const { close } = useModalContext();

    const [folders, setFolders] = useState<FolderTreeItem[]>([]);
    const [loading, setLoading] = useState(false);
    const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
    const { allowed: canMoveHere } = useLibraryPermission(
      'edit_own_content',
      knowledgeBaseId,
      selectedFolderId,
    );
    const { allowed: canMoveToRoot } = useLibraryPermission(
      'edit_own_content',
      knowledgeBaseId,
      null,
    );
    const [expandedFolders, setExpandedFolders] = useState<Set<string>>(() => new Set());
    const [loadedFolders, setLoadedFolders] = useState<Set<string>>(() => new Set());
    const [isCreatingFolder, setIsCreatingFolder] = useState(false);
    const [moving, setMoving] = useState(false);

    const createFolder = useFileStore((s) => s.createFolder);
    const moveItem = useTreeStore((s) => s.moveItem);

    // Sort items: folders only
    const sortItems = useCallback((items: FolderTreeItem[]): FolderTreeItem[] => {
      return [...items].sort((a, b) => a.name.localeCompare(b.name));
    }, []);

    // Fetch root level folders
    const fetchRootFolders = useCallback(async () => {
      setLoading(true);
      try {
        const response = await fileService.getKnowledgeItems({
          includeContentPreview: false,
          knowledgeBaseId,
          parentId: null,
          showFilesInKnowledgeBase: false,
        });

        // Filter only folders
        const folderItems = response.items
          .filter((item) => item.fileType === CUSTOM_FOLDER_FILE_TYPE)
          .map((item) => ({
            children: undefined,
            id: item.id,
            name: item.name,
            slug: item.slug,
          }));

        setFolders(sortItems(folderItems));
      } catch (error) {
        console.error('Failed to load folders:', error);
        setFolders([]);
      } finally {
        setLoading(false);
      }
    }, [knowledgeBaseId, sortItems]);

    useEffect(() => {
      void fetchRootFolders();
    }, [fetchRootFolders]);

    const handleLoadFolder = useCallback(
      async (folderId: string) => {
        if (loadedFolders.has(folderId)) return;

        try {
          const response = await fileService.getKnowledgeItems({
            includeContentPreview: false,
            knowledgeBaseId,
            parentId: folderId,
            showFilesInKnowledgeBase: false,
          });

          // Filter only folders
          const childFolders: FolderTreeItem[] = response.items
            .filter((item) => item.fileType === CUSTOM_FOLDER_FILE_TYPE)
            .map((item) => ({
              children: undefined,
              id: item.id,
              name: item.name,
              slug: item.slug,
            }));

          const sortedChildren = sortItems(childFolders);

          setFolders((prevFolders) => {
            const updateFolder = (folders: FolderTreeItem[]): FolderTreeItem[] => {
              return folders.map((folder) => {
                const folderKey = folder.slug || folder.id;
                if (folderKey === folderId) {
                  return { ...folder, children: sortedChildren };
                }
                if (folder.children) {
                  return { ...folder, children: updateFolder(folder.children) };
                }
                return folder;
              });
            };
            return updateFolder(prevFolders);
          });

          setLoadedFolders((prev) => new Set([...prev, folderId]));
        } catch (error) {
          console.error('Failed to load folder contents:', error);
        }
      },
      [knowledgeBaseId, loadedFolders, sortItems],
    );

    // Reload folder children (bypass the loadedFolders guard)
    const reloadFolderChildren = useCallback(
      async (folderId: string) => {
        try {
          const response = await fileService.getKnowledgeItems({
            includeContentPreview: false,
            knowledgeBaseId,
            parentId: folderId,
            showFilesInKnowledgeBase: false,
          });

          // Filter only folders
          const childFolders: FolderTreeItem[] = response.items
            .filter((item) => item.fileType === CUSTOM_FOLDER_FILE_TYPE)
            .map((item) => ({
              children: undefined,
              id: item.id,
              name: item.name,
              slug: item.slug,
            }));

          const sortedChildren = sortItems(childFolders);

          setFolders((prevFolders) => {
            const updateFolder = (folders: FolderTreeItem[]): FolderTreeItem[] => {
              return folders.map((folder) => {
                const folderKey = folder.slug || folder.id;
                if (folderKey === folderId) {
                  return { ...folder, children: sortedChildren };
                }
                if (folder.children) {
                  return { ...folder, children: updateFolder(folder.children) };
                }
                return folder;
              });
            };
            return updateFolder(prevFolders);
          });
        } catch (error) {
          console.error('Failed to reload folder contents:', error);
        }
      },
      [knowledgeBaseId, sortItems],
    );

    const handleToggleFolder = useCallback((folderId: string) => {
      setExpandedFolders((prev) => {
        const next = new Set(prev);
        if (next.has(folderId)) {
          next.delete(folderId);
        } else {
          next.add(folderId);
        }
        return next;
      });
    }, []);

    const handleFolderClick = useCallback((folderId: string, _folderSlug?: string | null) => {
      // Always use the document ID, not the slug
      setSelectedFolderId(folderId);
    }, []);

    const handleCreateNewFolder = useCallback(async () => {
      try {
        setIsCreatingFolder(true);

        // Create folder with default "Untitled" name
        const newFolderId = await createFolder(
          t('pageList.untitled', { ns: 'file' }),
          selectedFolderId ?? undefined, // Parent ID (root if none selected)
          knowledgeBaseId,
        );

        // Refresh tree to show the new folder
        if (selectedFolderId) {
          // Creating nested folder: auto-expand parent and reload its children
          setExpandedFolders((prev) => new Set([...prev, selectedFolderId]));
          await reloadFolderChildren(selectedFolderId);
        } else {
          // Creating at root: refetch root folders
          await fetchRootFolders();
        }

        // Auto-select the newly created folder
        setSelectedFolderId(newFolderId);
      } catch (error) {
        console.error('Failed to create folder:', error);
        toast.error(t('FileManager.actions.renameError'));
      } finally {
        setIsCreatingFolder(false);
      }
    }, [
      selectedFolderId,
      knowledgeBaseId,
      createFolder,
      reloadFolderChildren,
      fetchRootFolders,
      t,
    ]);

    const handleMoveTo = async (target: string) => {
      if (moving || (target ? !canMoveHere : !canMoveToRoot)) return;
      const { children } = useTreeStore.getState();
      const fromParent =
        Object.entries(children).find(([, items]) =>
          items.some((item) => item.id === fileId),
        )?.[0] ?? '';
      setMoving(true);
      try {
        await moveItem(fileId, fromParent, target);
        toast.success(t('FileManager.actions.moveSuccess'));
        close();
      } catch {
        toast.error(t('FileManager.actions.moveError'));
      } finally {
        setMoving(false);
      }
    };

    return (
      <>
        <Flexbox style={{ padding: 16 }}>
          <Flexbox horizontal justify="flex-end" style={{ marginBottom: 12 }}>
            <Button
              disabled={!canMoveHere}
              icon={<Icon icon={FolderIcon} />}
              loading={isCreatingFolder}
              size="small"
              type="default"
              onClick={handleCreateNewFolder}
            >
              {t('header.actions.newFolder', { ns: 'file' })}
            </Button>
          </Flexbox>
          <Flexbox style={{ maxHeight: 400, minHeight: 200, overflowY: 'auto' }}>
            {loading ? (
              <div>{t('loading', { ns: 'common' })}</div>
            ) : folders.length === 0 ? (
              <Flexbox align="center" justify="center" style={{ minHeight: 200 }}>
                <div style={{ color: 'var(--lobe-color-text-secondary)' }}>
                  {t('FileManager.noFolders')}
                </div>
              </Flexbox>
            ) : (
              <FolderTree
                expandedFolders={expandedFolders}
                items={folders}
                loadedFolders={loadedFolders}
                selectedKey={selectedFolderId}
                onFolderClick={handleFolderClick}
                onLoadFolder={handleLoadFolder}
                onToggleFolder={handleToggleFolder}
              />
            )}
          </Flexbox>
        </Flexbox>
        <ModalFooter>
          <Button disabled={moving} onClick={close}>
            {t('cancel', { ns: 'common' })}
          </Button>
          <Button
            disabled={!canMoveToRoot || moving}
            type="default"
            onClick={() => handleMoveTo('')}
          >
            {t('FileManager.actions.moveToRoot')}
          </Button>
          <Button
            disabled={!selectedFolderId || !canMoveHere || moving}
            type="primary"
            onClick={() => selectedFolderId && handleMoveTo(selectedFolderId)}
          >
            {t('FileManager.actions.moveHere')}
          </Button>
        </ModalFooter>
      </>
    );
  },
);

MoveToFolderModalContent.displayName = 'MoveToFolderModalContent';

export const openMoveToFolderModal = (props: MoveToFolderModalContentProps) =>
  createModal({
    content: <MoveToFolderModalContent {...props} />,
    footer: null,
    maskClosable: true,
    styles: { content: { padding: 0 } },
    title: translate('FileManager.actions.moveToFolder', { ns: 'components' }),
  });

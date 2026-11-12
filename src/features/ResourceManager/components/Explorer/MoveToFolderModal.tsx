import {
  Button,
  createModal,
  Flexbox,
  Icon,
  ModalFooter,
  Text,
  toast,
  useModalContext,
} from '@lobehub/ui';
import { t as translate } from 'i18next';
import { FolderIcon } from 'lucide-react';
import { memo, useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import AsyncError from '@/components/AsyncError';
import { useLibraryPermission } from '@/features/EnterpriseKnowledge/useLibraryPermission';
import { type FolderTreeItem } from '@/features/ResourceManager/components/FolderTree';
import FolderTree from '@/features/ResourceManager/components/FolderTree';
import { useFileStore } from '@/store/file';
import { useTreeStore } from '@/store/tree';

import { loadMoveTargetFolders } from './loadMoveTargetFolders';

interface MoveToFolderModalContentProps {
  fileId?: string;
  knowledgeBaseId?: string;
  /** Reuse the existing folder picker for controlled enterprise move-in destinations. */
  onMove?: (parentId: string | null) => void;
  title?: string;
}

const MoveToFolderModalContent = memo<MoveToFolderModalContentProps>(
  ({ fileId, knowledgeBaseId, onMove }) => {
    const { t } = useTranslation('components');
    const { close } = useModalContext();

    const [folders, setFolders] = useState<FolderTreeItem[]>([]);
    const [loading, setLoading] = useState(false);
    const [loadError, setLoadError] = useState<unknown>();
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

    // Fetch root level folders
    const fetchRootFolders = useCallback(async () => {
      setLoading(true);
      setLoadError(undefined);
      try {
        setFolders(await loadMoveTargetFolders(knowledgeBaseId, null));
      } catch (error) {
        console.error('Failed to load folders:', error);
        setLoadError(error);
      } finally {
        setLoading(false);
      }
    }, [knowledgeBaseId]);

    useEffect(() => {
      void fetchRootFolders();
    }, [fetchRootFolders]);

    const handleLoadFolder = useCallback(
      async (folderId: string) => {
        if (loadedFolders.has(folderId)) return;

        try {
          const sortedChildren = await loadMoveTargetFolders(knowledgeBaseId, folderId);

          setFolders((prevFolders) => {
            const updateFolder = (folders: FolderTreeItem[]): FolderTreeItem[] => {
              return folders.map((folder) => {
                const folderKey = folder.id;
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
          toast.error(t('enterprise.move.loadFailed', { ns: 'knowledgeBase' }));
        }
      },
      [knowledgeBaseId, loadedFolders, t],
    );

    // Reload folder children (bypass the loadedFolders guard)
    const reloadFolderChildren = useCallback(
      async (folderId: string) => {
        try {
          const sortedChildren = await loadMoveTargetFolders(knowledgeBaseId, folderId);

          setFolders((prevFolders) => {
            const updateFolder = (folders: FolderTreeItem[]): FolderTreeItem[] => {
              return folders.map((folder) => {
                const folderKey = folder.id;
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
          toast.error(t('enterprise.move.loadFailed', { ns: 'knowledgeBase' }));
        }
      },
      [knowledgeBaseId, t],
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
      if (onMove) {
        onMove(target || null);
        close();
        return;
      }
      if (!fileId) return;
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
          {onMove && !canMoveHere && (
            <Text type="secondary">
              {t('enterprise.move.destinationReadOnly', { ns: 'knowledgeBase' })}
            </Text>
          )}
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
            ) : loadError ? (
              <AsyncError
                error={loadError}
                variant="inline"
                onRetry={() => void fetchRootFolders()}
              />
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
    title: props.title ?? translate('FileManager.actions.moveToFolder', { ns: 'components' }),
  });

import type { KnowledgeBaseItem } from '@lobechat/types';
import type { ItemType } from '@lobehub/ui';
import { confirmModal, toast } from '@lobehub/ui';
import { t } from 'i18next';

import { useResourceManagerStore } from '@/features/ResourceManager/store';
import { enterpriseKnowledgeService } from '@/services/enterpriseKnowledge';
import { useFileStore } from '@/store/file';
import { useKnowledgeBaseStore } from '@/store/library';
import { useTreeStore } from '@/store/tree';
import { isTrpcErrorCode } from '@/utils/trpcError';

/** Both single and batch menus share the same confirmation, failure feedback and reconciliation. */
export const confirmContentMove = (params: {
  count: number;
  direction: 'in' | 'out';
  getIds: () => Promise<string[]>;
  knowledgeBaseId: string;
  libraryName: string;
  onMoved?: () => void;
  parentId?: string | null;
  targetKnowledgeBaseId?: string | null;
  targetLabel?: string;
}) => {
  const key = params.direction === 'in' ? 'moveIn' : 'moveOut';
  confirmModal({
    cancelText: t('cancel', { ns: 'common' }),
    title: t(`enterprise.${key}.title`, { ns: 'knowledgeBase', name: params.libraryName }),
    content: t(
      params.direction === 'in'
        ? 'enterprise.moveIn.confirm'
        : 'enterprise.moveOut.confirmDestination',
      {
        ns: 'knowledgeBase',
        name: params.libraryName,
        count: params.count,
        target: params.targetLabel ?? t('enterprise.moveOut.resourceRoot', { ns: 'knowledgeBase' }),
      },
    ),
    okText: t(`enterprise.${key}.confirmAction`, { ns: 'knowledgeBase' }),
    okButtonProps: { danger: true },
    onOk: async () => {
      let ids: string[];
      try {
        ids = await params.getIds();
        const input = { ids, knowledgeBaseId: params.knowledgeBaseId, parentId: params.parentId };
        if (params.direction === 'in') await enterpriseKnowledgeService.moveIn(input);
        else
          await enterpriseKnowledgeService.moveOut({
            ...input,
            ...(params.targetKnowledgeBaseId !== undefined
              ? { targetKnowledgeBaseId: params.targetKnowledgeBaseId }
              : {}),
          });
      } catch (error) {
        console.error('[enterpriseKnowledge] content move failed', error);
        toast.error(
          t(
            isTrpcErrorCode(error, 'FORBIDDEN')
              ? 'enterprise.node.readOnly'
              : isTrpcErrorCode(error, 'NOT_FOUND')
                ? 'enterprise.move.unavailable'
                : isTrpcErrorCode(error, 'CONFLICT')
                  ? 'enterprise.move.processing'
                  : 'enterprise.move.failed',
            { ns: 'knowledgeBase' },
          ),
        );
        // Keep the confirmation open so the same selection can be retried.
        throw error;
      }
      toast.success(t(`enterprise.${key}.success`, { ns: 'knowledgeBase' }));
      try {
        params.onMoved?.();
        useResourceManagerStore.getState().removeSearchHits(ids);
        useResourceManagerStore.getState().clearSelectAllState();
        const parentId = useFileStore.getState().queryParams?.parentId ?? '';
        // A moved folder disappears from the source tree and every persisted child cache.
        await useTreeStore.getState().dropNodes(ids, parentId);
        useTreeStore.getState().forgetLibrary(params.knowledgeBaseId);
        if (params.direction === 'out' && params.targetKnowledgeBaseId)
          useTreeStore.getState().forgetLibrary(params.targetKnowledgeBaseId);
        await Promise.all([
          useFileStore.getState().refreshFileList(),
          useKnowledgeBaseStore.getState().refreshKnowledgeBaseList(),
        ]);
      } catch (error) {
        console.error('[enterpriseKnowledge] content move refresh failed', error);
        toast.warning(t('enterprise.move.refreshFailed', { ns: 'knowledgeBase' }));
      }
    },
  });
};

/**
 * Choose a location inside the selected library before confirming; resource-root moves skip the picker.
 */
export const selectContentMoveTarget = async (params: Parameters<typeof confirmContentMove>[0]) => {
  if (params.direction === 'out' && !params.targetKnowledgeBaseId)
    return confirmContentMove({ ...params, parentId: null });
  const { openMoveToFolderModal } =
    await import('@/features/ResourceManager/components/Explorer/MoveToFolderModal');
  return openMoveToFolderModal({
    knowledgeBaseId:
      params.direction === 'in'
        ? params.knowledgeBaseId
        : (params.targetKnowledgeBaseId ?? undefined),
    title:
      params.direction === 'in'
        ? t('enterprise.moveIn.destinationTitle', { ns: 'knowledgeBase', name: params.libraryName })
        : t('enterprise.moveOut.libraryDestinationTitle', {
            ns: 'knowledgeBase',
            name: params.targetLabel,
          }),
    onMove: (parentId, folderName) =>
      confirmContentMove({
        ...params,
        parentId,
        targetLabel: folderName ? `${params.targetLabel} / ${folderName}` : params.targetLabel,
      }),
  });
};

/** The shared move-out submenu has one resource root and only the caller's ordinary libraries. */
export const getMoveOutMenuItems = (
  params: Omit<Parameters<typeof confirmContentMove>[0], 'direction'> & {
    libraries: KnowledgeBaseItem[];
    userId?: string | null;
    workspaceId?: string | null;
  },
): ItemType[] => {
  if (!params.userId || params.workspaceId) return [];
  const root = t('enterprise.moveOut.resourceRoot', { ns: 'knowledgeBase' });
  return [
    {
      key: 'move-out-resource-root',
      label: root,
      onClick: () =>
        confirmContentMove({
          ...params,
          direction: 'out',
          parentId: null,
          targetKnowledgeBaseId: null,
          targetLabel: root,
        }),
    },
    ...params.libraries
      .filter((kb) => !kb.enterprise && !kb.accessRevoked && kb.userId === params.userId)
      .map((kb) => ({
        key: `move-out-library-${kb.id}`,
        label: kb.name,
        onClick: () =>
          selectContentMoveTarget({
            ...params,
            direction: 'out',
            targetKnowledgeBaseId: kb.id,
            targetLabel: kb.name,
          }),
      })),
  ];
};

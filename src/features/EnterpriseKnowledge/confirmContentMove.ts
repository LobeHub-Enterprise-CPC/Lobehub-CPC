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
}) => {
  const key = params.direction === 'in' ? 'moveIn' : 'moveOut';
  confirmModal({
    cancelText: t('cancel', { ns: 'common' }),
    title: t(`enterprise.${key}.title`, { ns: 'knowledgeBase', name: params.libraryName }),
    content: t(`enterprise.${key}.confirm`, {
      ns: 'knowledgeBase',
      name: params.libraryName,
      count: params.count,
    }),
    okText: t(`enterprise.${key}.confirmAction`, { ns: 'knowledgeBase' }),
    okButtonProps: { danger: true },
    onOk: async () => {
      let ids: string[];
      try {
        ids = await params.getIds();
        const input = { ids, knowledgeBaseId: params.knowledgeBaseId, parentId: params.parentId };
        if (params.direction === 'in') await enterpriseKnowledgeService.moveIn(input);
        else await enterpriseKnowledgeService.moveOut(input);
      } catch (error) {
        console.error('[enterpriseKnowledge] content move failed', error);
        toast.error(
          t(
            isTrpcErrorCode(error, 'FORBIDDEN') || isTrpcErrorCode(error, 'NOT_FOUND')
              ? 'enterprise.node.readOnly'
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

/** Root grants do not describe child grants: choose a destination before confirming the move. */
export const selectContentMoveTarget = async (params: Parameters<typeof confirmContentMove>[0]) => {
  const { openMoveToFolderModal } =
    await import('@/features/ResourceManager/components/Explorer/MoveToFolderModal');
  return openMoveToFolderModal({
    knowledgeBaseId: params.knowledgeBaseId,
    title: t('enterprise.moveIn.destinationTitle', {
      ns: 'knowledgeBase',
      name: params.libraryName,
    }),
    onMove: (parentId) => confirmContentMove({ ...params, parentId }),
  });
};

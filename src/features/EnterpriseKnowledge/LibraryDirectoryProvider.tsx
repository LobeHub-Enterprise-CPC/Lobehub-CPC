import { toast } from '@lobehub/ui';
import { createContext, type PropsWithChildren, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { useFolderPath } from '@/features/ResourceManager/hooks/useFolderPath';
import { useResourceManagerFetchFolderBreadcrumb } from '@/features/ResourceManager/store';
import { useWorkspaceAwareNavigate } from '@/features/Workspace/useWorkspaceAwareNavigate';
import { enterpriseKnowledgeActions } from '@/store/enterpriseKnowledge';
import { knowledgeBaseSelectors, useKnowledgeBaseStore } from '@/store/library';
import { isTrpcErrorCode } from '@/utils/trpcError';

export const LibraryDirectoryContext = createContext<{
  knowledgeBaseId: string | null;
  nodeId: string | null;
  resolved: boolean;
} | null>(null);

/** Resolve route slugs once at the app's resource-drag boundary, keeping permission hooks host-independent. */
export const LibraryDirectoryProvider = ({ children }: PropsWithChildren) => {
  const { knowledgeBaseId, currentFolderSlug, isInKnowledgeBase } = useFolderPath();
  const breadcrumb = useResourceManagerFetchFolderBreadcrumb(
    isInKnowledgeBase ? currentFolderSlug : null,
  );
  const nodeId = breadcrumb.data.at(-1)?.id ?? null;
  const library = useKnowledgeBaseStore(
    knowledgeBaseSelectors.getLoadedKnowledgeBaseById(isInKnowledgeBase ? knowledgeBaseId : null),
  );
  const sync = enterpriseKnowledgeActions.useFetchNodeLevel(
    library?.enterprise && nodeId ? { knowledgeBaseId: library.id, nodeId } : null,
  );
  const navigate = useWorkspaceAwareNavigate();
  const { t } = useTranslation('knowledgeBase');
  const redirected = useRef<string | null>(null);
  useEffect(() => {
    if (!isInKnowledgeBase || !currentFolderSlug || !library?.enterprise) return;
    if (
      !isTrpcErrorCode(sync.error, 'NOT_FOUND') &&
      !isTrpcErrorCode(breadcrumb.error, 'NOT_FOUND')
    )
      return;
    const key = `${library.id}:${currentFolderSlug}`;
    if (redirected.current === key) return;
    redirected.current = key;
    toast.warning(t('enterprise.node.accessLost'));
    navigate(`/resource/library/${library.id}`, { replace: true });
  }, [isInKnowledgeBase, currentFolderSlug, library, sync.error, breadcrumb.error, navigate, t]);
  return (
    <LibraryDirectoryContext
      value={{
        knowledgeBaseId: isInKnowledgeBase ? knowledgeBaseId : null,
        nodeId,
        resolved: !currentFolderSlug || !!nodeId,
      }}
    >
      {children}
    </LibraryDirectoryContext>
  );
};

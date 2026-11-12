import type { EnterpriseItemAccess } from '@lobechat/types';
import { use } from 'react';

import { useResourceManagerStore } from '@/features/ResourceManager/store';
import { usePermission } from '@/hooks/usePermission';
import { cacheScope } from '@/libs/replica';
import {
  enterpriseKnowledgeActions,
  enterpriseKnowledgeSelectors,
  useEnterpriseKnowledgeStore,
} from '@/store/enterpriseKnowledge';
import { fileManagerSelectors, useFileStore } from '@/store/file';
import { knowledgeBaseSelectors, useKnowledgeBaseStore } from '@/store/library';

import { getKnowledgeBaseCapabilities } from './capabilities';
import { LibraryDirectoryContext } from './LibraryDirectoryProvider';

/** Shared permission source for toolbars, menus, drag/drop and keyboard actions. */
export const useLibraryPermission = (
  action: 'create_content' | 'edit_own_content',
  knowledgeBaseId?: string | null,
  nodeId?: string | null,
  itemAccess?: EnterpriseItemAccess,
) => {
  const currentLibraryId = useResourceManagerStore((s) => s.libraryId);
  const id = knowledgeBaseId === undefined ? currentLibraryId : knowledgeBaseId;
  const role = usePermission(action);
  const library = useKnowledgeBaseStore(knowledgeBaseSelectors.getLoadedKnowledgeBaseById(id));
  const scope = cacheScope.use();
  const denied =
    useKnowledgeBaseStore(knowledgeBaseSelectors.sessionAccess(scope, id ?? '')) === 'denied';
  const directory = use(LibraryDirectoryContext);
  const isCurrentDirectory = !!directory && directory.knowledgeBaseId === id;
  const targetNode = nodeId === undefined ? (isCurrentDirectory ? directory.nodeId : null) : nodeId;
  const unresolvedFolder = nodeId === undefined && isCurrentDirectory && !directory.resolved;
  const loadedItem = useFileStore(fileManagerSelectors.getFileByChunkTargetId(nodeId));
  const rowAccess = itemAccess ?? loadedItem?.enterpriseAccess;
  const effectiveLibrary =
    library ??
    (rowAccess ? { enterprise: { accessLevel: rowAccess.level, ownerName: '' } } : undefined);
  const params =
    library?.enterprise && !rowAccess && !unresolvedFolder && id
      ? { knowledgeBaseId: id, nodeId: targetNode }
      : null;
  const levelSync = enterpriseKnowledgeActions.useFetchNodeLevel(params);
  const resolved = useEnterpriseKnowledgeStore(enterpriseKnowledgeSelectors.nodeLevel(params));
  const nodeLevel = effectiveLibrary?.enterprise
    ? levelSync.error || unresolvedFolder
      ? null
      : (rowAccess?.level ?? resolved?.level ?? null)
    : undefined;
  const capabilities = getKnowledgeBaseCapabilities(
    denied ? { accessRevoked: true } : effectiveLibrary,
    role.allowed,
    nodeLevel,
  );
  return {
    ...role,
    ...capabilities,
    // An unresolved library must not briefly expose personal-mode write controls.
    allowed: (!id || !!library) && capabilities.canEditContent,
    library,
    item: loadedItem,
    level: nodeLevel,
  };
};

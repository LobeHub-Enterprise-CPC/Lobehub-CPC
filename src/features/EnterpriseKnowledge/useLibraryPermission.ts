import { useResourceManagerStore } from '@/features/ResourceManager/store';
import { usePermission } from '@/hooks/usePermission';
import { cacheScope } from '@/libs/replica';
import { knowledgeBaseSelectors, useKnowledgeBaseStore } from '@/store/library';

import { getKnowledgeBaseCapabilities } from './capabilities';

/** Shared permission source for toolbars, menus, drag/drop and keyboard actions. */
export const useLibraryPermission = (
  action: 'create_content' | 'edit_own_content',
  knowledgeBaseId?: string | null,
) => {
  const currentLibraryId = useResourceManagerStore((s) => s.libraryId);
  const id = knowledgeBaseId === undefined ? currentLibraryId : knowledgeBaseId;
  const role = usePermission(action);
  const library = useKnowledgeBaseStore(knowledgeBaseSelectors.getLoadedKnowledgeBaseById(id));
  const scope = cacheScope.use();
  const denied =
    useKnowledgeBaseStore(knowledgeBaseSelectors.sessionAccess(scope, id ?? '')) === 'denied';
  const capabilities = getKnowledgeBaseCapabilities(
    denied ? { accessRevoked: true } : library,
    role.allowed,
  );
  return {
    ...role,
    ...capabilities,
    // An unresolved library must not briefly expose personal-mode write controls.
    allowed: (!id || !!library) && capabilities.canEditContent,
    library,
  };
};

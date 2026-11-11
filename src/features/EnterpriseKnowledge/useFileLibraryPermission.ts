import { usePermission } from '@/hooks/usePermission';
import { cacheScope } from '@/libs/replica';
import {
  enterpriseKnowledgeActions,
  enterpriseKnowledgeSelectors,
  useEnterpriseKnowledgeStore,
} from '@/store/enterpriseKnowledge';
import { knowledgeBaseSelectors, useKnowledgeBaseStore } from '@/store/library';

import { getKnowledgeBaseCapabilities } from './capabilities';

/** Reuse findById's real memberships to gate mutations in citation image previews. */
export const useFileLibraryPermission = (id?: string) => {
  const role = usePermission('edit_own_content');
  useKnowledgeBaseStore((s) => s.useFetchKnowledgeBaseList)();
  const libraries = useKnowledgeBaseStore(knowledgeBaseSelectors.getKnowledgeBaseList());
  const hasEnterprise = libraries?.some((kb) => kb.enterprise);
  const sync = enterpriseKnowledgeActions.useFetchFileLibraries(id && hasEnterprise ? id : null);
  const ids = useEnterpriseKnowledgeStore(enterpriseKnowledgeSelectors.fileLibraries(id));
  const scope = cacheScope.use();
  const denied = useKnowledgeBaseStore((s) =>
    ids?.some((id) => s.knowledgeBaseSessionAccess[`${scope}|${id}`] === 'denied'),
  );
  const enterpriseLibrary = libraries?.find((kb) => kb.enterprise && ids?.includes(kb.id));
  return {
    allowed:
      !denied &&
      !!libraries &&
      (!hasEnterprise || (!!ids && !sync.error)) &&
      getKnowledgeBaseCapabilities(enterpriseLibrary, role.allowed).canEditContent,
  };
};

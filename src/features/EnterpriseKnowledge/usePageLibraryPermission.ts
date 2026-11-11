import { usePageEditorStore } from '@/features/PageEditor/store';
import { useKnowledgeBaseItem } from '@/features/ResourceManager/hooks/useKnowledgeItem';
import { useDocumentStore } from '@/store/document';

import { useLibraryPermission } from './useLibraryPermission';

export const usePageLibraryPermission = (action: 'create_content' | 'edit_own_content') => {
  const documentId = usePageEditorStore((s) => s.documentId);
  const openedLibraryId = usePageEditorStore((s) => s.knowledgeBaseId);
  const metadataLibraryId = useDocumentStore((s) =>
    documentId ? s.documentDetailMap[documentId]?.document?.knowledgeBaseId : undefined,
  );
  const libraryId =
    openedLibraryId ?? (typeof metadataLibraryId === 'string' ? metadataLibraryId : undefined);
  useKnowledgeBaseItem(libraryId || '');
  return useLibraryPermission(action, libraryId ?? null);
};

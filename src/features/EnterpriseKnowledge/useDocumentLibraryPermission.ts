import { useKnowledgeBaseItem } from '@/features/ResourceManager/hooks/useKnowledgeItem';
import { useDocumentStore } from '@/store/document';

import { useLibraryPermission } from './useLibraryPermission';

/** Documents opened through a citation retain their library column, even outside resource routes. */
export const useDocumentLibraryPermission = (
  documentId: string | undefined,
  openedLibraryId?: string,
) => {
  const libraryId = useDocumentStore((s) =>
    documentId ? s.documentDetailMap[documentId]?.document?.knowledgeBaseId : undefined,
  );
  const id = openedLibraryId || libraryId;
  useKnowledgeBaseItem(id || '');
  return useLibraryPermission('edit_own_content', id || null, documentId ?? null);
};

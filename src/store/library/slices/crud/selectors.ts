import { type KnowledgeBaseStoreState } from '@/store/library/initialState';

import { knowledgeBaseListKey, type KnowledgeBaseVisibility } from './projection';

const activeKnowledgeBaseId = (s: KnowledgeBaseStoreState) => s.activeKnowledgeBaseId;

/** One KB by id — backed by the `knowledgeBaseItem` replica. */
const getKnowledgeBaseById = (id: string) => (s: KnowledgeBaseStoreState) =>
  s.knowledgeBaseDetailMap[id];

const getKnowledgeBaseNameById = (id: string) => (s: KnowledgeBaseStoreState) =>
  getKnowledgeBaseById(id)(s)?.name;

/** One KB list surface (`all` / `private` / `public`) — backed by the `knowledgeBaseList` replica. */
const getKnowledgeBaseList =
  (visibility?: KnowledgeBaseVisibility) => (s: KnowledgeBaseStoreState) =>
    s.knowledgeBaseListMap[knowledgeBaseListKey(visibility)];

/** Whether a list surface has been read (hydrated or fetched) at least once. */
const isKnowledgeBaseListInit =
  (visibility?: KnowledgeBaseVisibility) => (s: KnowledgeBaseStoreState) =>
    s.knowledgeBaseListMap[knowledgeBaseListKey(visibility)] !== undefined;

const getLoadedKnowledgeBaseById = (id?: string | null) => (s: KnowledgeBaseStoreState) => {
  if (!id) return undefined;
  return (
    s.knowledgeBaseDetailMap[id] ??
    Object.values(s.knowledgeBaseListMap)
      .flat()
      .find((kb) => kb?.id === id)
  );
};

const sessionAccess = (scope: string, id: string) => (s: KnowledgeBaseStoreState) =>
  s.knowledgeBaseSessionAccess[`${scope}|${id}`];

export const knowledgeBaseSelectors = {
  sessionAccess,
  getLoadedKnowledgeBaseById,
  activeKnowledgeBaseId,
  getKnowledgeBaseById,
  getKnowledgeBaseList,
  getKnowledgeBaseNameById,
  isKnowledgeBaseListInit,
};

import type { FtsSearchDatabaseResult } from '@/database/repositories/ftsSearch';
import { KnowledgeRepo } from '@/database/repositories/knowledge';

import { type EnterpriseAccessCtx, listAccessibleEnterpriseKnowledgeBases } from './index';

/** Search names inside the requester's currently accessible libraries, never an owner's global scope. */
export const searchEnterpriseKnowledge = async (
  ctx: EnterpriseAccessCtx,
  input: { query: string; type?: string; limitPerType?: number; offset?: number },
): Promise<FtsSearchDatabaseResult[]> => {
  if (
    ctx.workspaceId ||
    (input.type && !['knowledgeBase', 'file', 'folder', 'page'].includes(input.type))
  )
    return [];
  const libraries = await listAccessibleEnterpriseKnowledgeBases(ctx);
  const limit = input.limitPerType ?? 5;
  const offset = input.offset ?? 0;
  const keyword = input.query.toLocaleLowerCase();
  const results: FtsSearchDatabaseResult[] = [];
  for (const kb of libraries) {
    if (
      (!input.type || input.type === 'knowledgeBase') &&
      kb.name.toLocaleLowerCase().includes(keyword)
    ) {
      results.push({
        createdAt: kb.createdAt,
        avatar: kb.avatar,
        id: kb.id,
        relevance: 1,
        title: kb.name,
        type: 'knowledgeBase',
        updatedAt: kb.updatedAt,
      });
    }
    if (input.type === 'knowledgeBase') continue;
    const rows = await new KnowledgeRepo(ctx.serverDB, kb.userId!).query({
      knowledgeBaseId: kb.id,
      q: input.query,
      includeContent: false,
      limit: limit + offset,
    });
    for (const row of rows) {
      const type =
        row.fileType === 'custom/folder'
          ? 'folder'
          : row.fileType === 'custom/document'
            ? 'page'
            : 'file';
      if (!input.type || input.type === type) {
        const base = {
          createdAt: row.createdAt,
          id: type === 'file' ? row.id : (row.documentId ?? row.id),
          relevance: 1,
          title: row.name,
          updatedAt: row.updatedAt,
        };
        if (type === 'file')
          results.push({
            ...base,
            type,
            fileType: row.fileType,
            knowledgeBaseId: kb.id,
            name: row.name,
            size: row.size,
            url: `/f/${row.id}`,
          });
        else if (type === 'folder')
          results.push({ ...base, type, knowledgeBaseId: kb.id, slug: row.slug ?? null });
        else results.push({ ...base, type });
      }
    }
  }
  return results.slice(offset, offset + limit);
};

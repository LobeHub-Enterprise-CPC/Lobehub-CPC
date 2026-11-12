import { isEnterpriseKnowledgeEnabled } from '@lobechat/business-knowledge';
import { TRPCError } from '@trpc/server';

import {
  type EnterpriseAccessCtx,
  type KnowledgeAccessScope,
} from '@/server/services/enterpriseKnowledge';
import {
  type ContentTarget,
  contentTargetSchema,
  resolveContentScope,
} from '@/server/services/enterpriseKnowledge/contentScope';

// Only fields the named procedure really accepts may select a data scope.
// Looking at arbitrary raw fields before tRPC strips unknown keys permits scope injection.
const procedureTargets: Record<string, Record<string, (keyof ContentTarget)[]>> = {
  file: {
    createFile: ['knowledgeBaseId', 'parentId'],
    findById: ['id'],
    getReadableUrl: ['id'],
    getFileItemById: ['id'],
    getFiles: ['knowledgeBaseId', 'parentId'],
    getKnowledgeItems: ['knowledgeBaseId', 'parentId'],
    resolveKnowledgeItemIds: ['knowledgeBaseId', 'parentId'],
    deleteKnowledgeItemsByQuery: ['knowledgeBaseId', 'parentId'],
    getKnowledgeItemStatusesByIds: ['ids'],
    updateFile: ['id', 'parentId'],
    removeFile: ['id'],
    removeUnreferencedFile: ['id'],
    removeFiles: ['ids'],
    removeFileAsyncTask: ['id'],
    publishFileToWorkspace: ['id'],
    setFileVisibility: ['id'],
    transferEntity: ['id'],
    copyEntityToWorkspace: ['id'],
  },
  document: {
    createDocument: ['knowledgeBaseId', 'parentId'],
    getDocumentById: ['id'],
    deleteDocument: ['id'],
    deleteDocuments: ['ids'],
    listDocumentHistory: ['documentId'],
    getDocumentHistoryItem: ['documentId'],
    compareDocumentHistoryItems: ['documentId'],
    saveDocumentHistory: ['documentId'],
    getFolderBreadcrumb: ['slug'],
    parseDocument: ['id'],
    parseFileContent: ['id'],
    acquireDocumentLock: ['id'],
    getDocumentLock: ['id'],
    releaseDocumentLock: ['id'],
    updateDocument: ['id', 'parentId'],
    transferDocument: ['documentId'],
    copyDocumentToWorkspace: ['documentId'],
    publishDocumentToWorkspace: ['id'],
    setDocumentVisibility: ['id'],
  },
  knowledge: { getKnowledgeItems: ['knowledgeBaseId', 'parentId'] },
  chunk: {
    getChunksByFileId: ['id'],
    createEmbeddingChunksTask: ['id'],
    createParseFileTask: ['id'],
    retryParseFileTask: ['id'],
    semanticSearch: ['fileIds'],
  },
};

/** Request-local data scope; caller identity stays separate for upload attribution and reservations. */
export const enterpriseContentContext = async (
  ctx: EnterpriseAccessCtx,
  raw: unknown,
  write: boolean,
  options: { domain: string; procedure: string; forbidExport?: boolean; batchCreate?: boolean },
) => {
  let scope: KnowledgeAccessScope = { enterprise: false };
  if (!ctx.workspaceId && isEnterpriseKnowledgeEnabled()) {
    if (options?.batchCreate) {
      const { z } = await import('zod');
      const targets = z
        .object({
          documents: z.array(contentTargetSchema.pick({ knowledgeBaseId: true, parentId: true })),
        })
        .parse(raw).documents;
      const scopes = await Promise.all(
        targets.map((target) => resolveContentScope(ctx, target, 'edit')),
      );
      scope = scopes.find((item) => item.enterprise) ?? scope;
      const batchScope = scope;
      // A single model cannot safely create rows belonging to multiple scopes.
      if (
        batchScope.enterprise &&
        scopes.some(
          (item) => !item.enterprise || item.knowledgeBaseId !== batchScope.knowledgeBaseId,
        )
      ) {
        throw new TRPCError({ code: 'NOT_FOUND' });
      }
    } else {
      const mask: Partial<Record<keyof ContentTarget, true>> = Object.fromEntries(
        (procedureTargets[options.domain]?.[options.procedure] ?? []).map((key) => [key, true]),
      );
      scope = await resolveContentScope(
        ctx,
        contentTargetSchema.pick(mask).parse(raw ?? {}),
        write
          ? 'edit'
          : options.domain === 'document' && options.procedure === 'getFolderBreadcrumb'
            ? 'path'
            : 'view',
      );
    }
  }
  if (scope.enterprise && options?.forbidExport) throw new TRPCError({ code: 'FORBIDDEN' });
  return {
    enterpriseCallerId: ctx.userId,
    enterpriseScope: scope,
    enterpriseDataUserId: scope.enterprise ? scope.ownerId : ctx.userId,
  };
};

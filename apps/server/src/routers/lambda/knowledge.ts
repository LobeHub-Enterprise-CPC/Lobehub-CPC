import { wsCompatProcedure } from '@/business/server/trpc-middlewares/workspaceAuth';
import { AsyncTaskModel } from '@/database/models/asyncTask';
import { ChunkModel } from '@/database/models/chunk';
import { DocumentModel } from '@/database/models/document';
import { FileModel } from '@/database/models/file';
import { KnowledgeRepo } from '@/database/repositories/knowledge';
import { router } from '@/libs/trpc/lambda';
import { serverDatabase } from '@/libs/trpc/lambda/middleware';
import { queryEnterprisePage } from '@/server/services/enterpriseKnowledge/listAccess';
import { FileService } from '@/server/services/file';
import { AsyncTaskStatus, AsyncTaskType } from '@/types/asyncTask';
import { type FileListItem } from '@/types/files';
import { QueryFileListSchema } from '@/types/files';

import { enterpriseContentContext } from './_helpers/enterpriseContent';
import {
  assertKnowledgeBaseBrowsable,
  getRestrictedKnowledgeBaseIds,
} from './_helpers/knowledgeBaseAccess';

const knowledgeProcedure = wsCompatProcedure.use(serverDatabase).use(async (opts) => {
  const original = opts.ctx;
  const enterprise = await enterpriseContentContext(original, await opts.getRawInput(), false, {
    domain: 'knowledge',
    procedure: opts.path.split('.').at(-1)!,
  });
  const ctx = { ...original, ...enterprise };
  const wsId = ctx.workspaceId ?? undefined;

  return opts.next({
    ctx: {
      ...enterprise,
      asyncTaskModel: new AsyncTaskModel(ctx.serverDB, ctx.enterpriseDataUserId, wsId),
      chunkModel: new ChunkModel(ctx.serverDB, ctx.enterpriseDataUserId, wsId),
      documentModel: new DocumentModel(ctx.serverDB, ctx.enterpriseDataUserId, wsId),
      fileModel: new FileModel(ctx.serverDB, ctx.enterpriseDataUserId, wsId),
      fileService: new FileService(ctx.serverDB, ctx.enterpriseDataUserId, wsId),
      knowledgeRepo: new KnowledgeRepo(ctx.serverDB, ctx.enterpriseDataUserId, wsId),
    },
  });
});

export const knowledgeRouter = router({
  getKnowledgeItems: knowledgeProcedure.input(QueryFileListSchema).query(async ({ ctx, input }) => {
    const excludeKnowledgeBaseIds = input.knowledgeBaseId
      ? undefined
      : await getRestrictedKnowledgeBaseIds(ctx);
    if (input.knowledgeBaseId) await assertKnowledgeBaseBrowsable(ctx, input.knowledgeBaseId);

    const knowledgeItems = await queryEnterprisePage(
      { ...ctx, userId: ctx.enterpriseCallerId },
      (page) =>
        ctx.knowledgeRepo.query({
          ...input,
          ...(ctx.enterpriseScope.enterprise
            ? { knowledgeBaseId: ctx.enterpriseScope.knowledgeBaseId }
            : {}),
          excludeKnowledgeBaseIds,
          ...page,
        }),
      {
        limit: input.limit,
        offset: input.offset,
        scope: ctx.enterpriseScope.enterprise ? ctx.enterpriseScope : undefined,
      },
    );

    // Process files (add chunk info and async task status)
    const fileItems = knowledgeItems.filter((item) => item.sourceType === 'file');
    const fileIds = fileItems.map((item) => item.id);
    const chunks = await ctx.chunkModel.countByFileIds(fileIds);

    const chunkTaskIds = fileItems.map((item) => item.chunkTaskId).filter(Boolean) as string[];
    const chunkTasks = await ctx.asyncTaskModel.findByIds(chunkTaskIds, AsyncTaskType.Chunking);

    const embeddingTaskIds = fileItems
      .map((item) => item.embeddingTaskId)
      .filter(Boolean) as string[];
    const embeddingTasks = await ctx.asyncTaskModel.findByIds(
      embeddingTaskIds,
      AsyncTaskType.Embedding,
    );

    // Combine all items with their metadata
    const fileUrls = await ctx.fileService.getFileBrowserUrls(fileItems);
    const urlById = new Map(fileItems.map((item, index) => [item.id, fileUrls[index]]));
    const resultItems = [] as any[];
    for (const item of knowledgeItems) {
      if (item.sourceType === 'file') {
        const chunkTask = item.chunkTaskId
          ? chunkTasks.find((task) => task.id === item.chunkTaskId)
          : null;
        const embeddingTask = item.embeddingTaskId
          ? embeddingTasks.find((task) => task.id === item.embeddingTaskId)
          : null;

        resultItems.push({
          ...item,
          chunkCount: chunks.find((chunk) => chunk.id === item.id)?.count ?? null,
          chunkingError: chunkTask?.error ?? null,
          chunkingStatus: chunkTask?.status as AsyncTaskStatus,
          editorData: null,
          embeddingError: embeddingTask?.error ?? null,
          embeddingStatus: embeddingTask?.status as AsyncTaskStatus,
          finishEmbedding: embeddingTask?.status === AsyncTaskStatus.Success,
          url: item.url ? urlById.get(item.id) : undefined,
        } as FileListItem);
      } else {
        // Document item - no chunk processing needed, includes editorData
        const documentItem = {
          ...item,
          ...(item.fileId && item.enterpriseAccess
            ? { url: await ctx.fileService.getFileBrowserUrl(item) }
            : {}),
          chunkCount: null,
          chunkingError: null,
          chunkingStatus: null,
          embeddingError: null,
          embeddingStatus: null,
          finishEmbedding: false,
        } as FileListItem;
        console.info('[API getKnowledgeItems] Processing document:', {
          editorDataPreview: item.editorData ? JSON.stringify(item.editorData).slice(0, 100) : null,
          hasEditorData: !!item.editorData,
          id: item.id,
          name: item.name,
        });
        resultItems.push(documentItem);
      }
    }

    return resultItems;
  }),
});

export type KnowledgeRouter = typeof knowledgeRouter;

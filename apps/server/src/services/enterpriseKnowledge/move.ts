import {
  recordEnterpriseKbContentMove,
  recordEnterpriseKbItemUploaders,
} from '@lobechat/business-knowledge';
import { TRPCError } from '@trpc/server';
import { and, eq, isNull } from 'drizzle-orm';

import { businessFileTransferStorageCheck } from '@/business/server/lambda-routers/file';
import { DocumentModel } from '@/database/models/document';
import { FileModel } from '@/database/models/file';
import { documents } from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';
import { lockEnterpriseKb } from '@/server/services/enterpriseKnowledgeAdmin/shared';

import { classifyEnterpriseContentIds } from './contentClassification';
import {
  type EnterpriseAccessCtx,
  getUserDisplayNames,
  itemsBelongToKnowledgeBase,
  resolveKnowledgeBaseScope,
} from './index';
import { copyMoveGraph, loadMoveGraph } from './moveGraph';
import { getEnterpriseNodeMetadata } from './nodeAccess';
import { trashEnterpriseItems } from './trash';

export interface ContentMoveInput {
  ids: string[];
  knowledgeBaseId: string;
  parentId?: string | null;
}

/** Explicit personal/enterprise move: authorization, copy, original removal and event commit together. */
export const moveEnterpriseContent = async (
  ctx: EnterpriseAccessCtx,
  input: ContentMoveInput,
  direction: 'in' | 'out',
) => {
  if (ctx.workspaceId) throw new TRPCError({ code: 'NOT_FOUND' });
  return ctx.serverDB.transaction(async (tx) => {
    const db = tx as unknown as LobeChatDatabase;
    const accessCtx = { ...ctx, serverDB: db };
    const scope = await resolveKnowledgeBaseScope(
      accessCtx,
      input.knowledgeBaseId,
      direction === 'in' ? 'edit' : 'path',
      direction === 'in' ? input.parentId : undefined,
    );
    if (!scope.enterprise) throw new TRPCError({ code: 'NOT_FOUND' });
    await lockEnterpriseKb(db, { id: input.knowledgeBaseId, userId: scope.ownerId });
    if (direction === 'in' && input.parentId) {
      const metadata = await getEnterpriseNodeMetadata(
        db,
        input.knowledgeBaseId,
        scope.ownerId,
        input.parentId,
      );
      if (metadata.node.kind !== 'folder') throw new TRPCError({ code: 'BAD_REQUEST' });
    }
    if (direction === 'out' && input.parentId) {
      // A personal destination must stay personal through every ancestor, even for the KB owner.
      let id: string | null = input.parentId;
      const ancestors: string[] = [];
      while (id) {
        if (ancestors.includes(id)) throw new TRPCError({ code: 'NOT_FOUND' });
        const [folder] = await db
          .select()
          .from(documents)
          .where(
            and(
              eq(documents.id, id),
              eq(documents.userId, ctx.userId),
              isNull(documents.workspaceId),
            ),
          )
          .for('update');
        if (
          !folder ||
          folder.isDeleted ||
          folder.fileType !== 'custom/folder' ||
          folder.knowledgeBaseId
        )
          throw new TRPCError({ code: 'NOT_FOUND' });
        ancestors.push(id);
        id = folder.parentId;
      }
      if ((await classifyEnterpriseContentIds(accessCtx, ancestors)).size)
        throw new TRPCError({ code: 'NOT_FOUND' });
    }
    const sourceUserId = direction === 'in' ? ctx.userId : scope.ownerId;
    const graph = await loadMoveGraph(db, sourceUserId, input.ids);
    const allIds = [...graph.documents.keys(), ...graph.files.keys()];
    if (direction === 'in') {
      if ((await classifyEnterpriseContentIds(accessCtx, allIds)).size)
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Use move out to move enterprise knowledge content',
        });
    } else {
      for (const id of allIds) {
        if (!(await itemsBelongToKnowledgeBase(db, [id], input.knowledgeBaseId)))
          throw new TRPCError({ code: 'NOT_FOUND' });
        await resolveKnowledgeBaseScope(accessCtx, input.knowledgeBaseId, 'edit', id);
      }
    }
    const targetUserId = direction === 'in' ? scope.ownerId : ctx.userId;
    await businessFileTransferStorageCheck({
      additionalSize:
        direction === 'in' && sourceUserId === targetUserId
          ? 0
          : [...graph.files.values()].reduce((sum, file) => sum + file.size, 0),
      targetUserId,
      targetWorkspaceId: null,
    });
    const copied = await copyMoveGraph(db, graph, {
      knowledgeBaseId: direction === 'in' ? input.knowledgeBaseId : null,
      parentId: input.parentId ?? null,
      userId: targetUserId,
    });
    const items = graph.roots.map((sourceId) => {
      const doc = graph.documents.get(sourceId);
      return {
        sourceId,
        targetId: (copied.documentMap.get(sourceId) ?? copied.fileMap.get(sourceId))!,
        name: doc ? (doc.title ?? doc.filename ?? sourceId) : graph.files.get(sourceId)!.name,
        kind: doc
          ? doc.fileType === 'custom/folder'
            ? ('folder' as const)
            : ('document' as const)
          : ('file' as const),
      };
    });
    const actor = {
      id: ctx.userId,
      kind: 'member' as const,
      name: (await getUserDisplayNames(db, [ctx.userId])).get(ctx.userId) ?? ctx.userId,
    };
    if (direction === 'in') {
      // Copies already hold references to every blob. Ordinary deletion cannot remove those blobs.
      const fileModel = new FileModel(db, ctx.userId);
      for (const id of graph.files.keys()) await fileModel.delete(id);
      const docModel = new DocumentModel(db, ctx.userId);
      for (const id of graph.documents.keys()) await docModel.delete(id);
      await recordEnterpriseKbItemUploaders(
        db,
        [...copied.documentMap.values(), ...copied.fileMap.values()].map((itemId) => ({
          knowledgeBaseId: input.knowledgeBaseId,
          itemId,
          actor,
        })),
      );
    } else {
      await trashEnterpriseItems(accessCtx, scope, graph.roots);
    }
    await recordEnterpriseKbContentMove(db, {
      actor,
      direction,
      knowledgeBaseId: input.knowledgeBaseId,
      items,
    });
    return { items };
  });
};

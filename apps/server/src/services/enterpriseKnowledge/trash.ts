import { TRASH_RETENTION_MS } from '@lobechat/const';
import { TRPCError } from '@trpc/server';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';

import { FileModel } from '@/database/models/file';
import { documents, files, trashItems } from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';
import { restoreStamp, trashStamp } from '@/database/utils/softDelete';
import type { TrashHandler } from '@/server/services/trash/handlers/types';

import {
  type EnterpriseAccessCtx,
  type EnterpriseScope,
  itemsBelongToKnowledgeBase,
  resolveItemsScope,
} from './index';

/** Enterprise content uses the existing text-valued registry, without changing the kernel schema. */
export const trashEnterpriseItems = async (
  ctx: EnterpriseAccessCtx,
  scope: EnterpriseScope,
  ids: string[],
) =>
  ctx.serverDB.transaction(async (tx) => {
    const db = tx as unknown as LobeChatDatabase;
    const date = new Date();
    const pending = [...new Set(ids)];
    const visited = new Set<string>();
    const roots: string[] = [];
    while (pending.length) {
      const id = pending.shift()!;
      if (visited.has(id)) continue;
      visited.add(id);
      if (!(await itemsBelongToKnowledgeBase(db, [id], scope.knowledgeBaseId)))
        throw new TRPCError({ code: 'NOT_FOUND' });
      const [doc] = await db
        .select()
        .from(documents)
        .where(
          and(
            eq(documents.id, id),
            eq(documents.userId, scope.ownerId),
            isNull(documents.workspaceId),
          ),
        );
      const [file] = doc
        ? []
        : await db
            .select()
            .from(files)
            .where(
              and(eq(files.id, id), eq(files.userId, scope.ownerId), isNull(files.workspaceId)),
            );
      if (!doc && !file) throw new TRPCError({ code: 'NOT_FOUND' });
      // Already-trashed children belong to their original deletion, not this cascade.
      if ((doc ?? file).isDeleted) continue;
      if (doc?.fileType === 'custom/folder') {
        const children = await db
          .select({ id: documents.id })
          .from(documents)
          .where(eq(documents.parentId, doc.id));
        const childFiles = await db
          .select({ id: files.id })
          .from(files)
          .where(eq(files.parentId, doc.id));
        pending.push(...children.map((row) => row.id), ...childFiles.map((row) => row.id));
      }
      if (doc?.fileId) pending.push(doc.fileId);
      if (file) {
        const derived = await db
          .select({ id: documents.id })
          .from(documents)
          .where(eq(documents.fileId, file.id));
        pending.push(...derived.map((row) => row.id));
      }
      const type = doc ? 'document' : 'file';
      const table = doc ? documents : files;
      await db
        .update(table)
        .set(trashStamp(date))
        .where(and(eq(table.id, id), eq(table.userId, scope.ownerId), isNull(table.workspaceId)));
      const [root] = await db
        .insert(trashItems)
        .values({
          deletedAt: date,
          deletedByUserId: ctx.userId,
          expiresAt: new Date(date.getTime() + TRASH_RETENTION_MS),
          // The registry column is text. Its kernel TS enum currently lists only the chat-domain kinds.
          resourceType: sql`${type}`,
          resourceId: id,
          userId: scope.ownerId,
          title: doc ? (doc.title ?? doc.filename) : file!.name,
          meta: { kind: type },
          rootId: roots[0] ?? null,
        })
        .onConflictDoNothing()
        .returning({ id: trashItems.id });
      if (root) roots.push(root.id);
    }
    return { count: new Set(ids).size };
  });

export const enterpriseContentTrashHandler: Pick<TrashHandler, 'restore' | 'purge'> = {
  restore: async (ctx, root, children) => {
    const rows = [root, ...children];
    const ids = rows.map((row) => row.resourceId);
    await resolveItemsScope({ serverDB: ctx.db, userId: ctx.userId }, ids, 'owner', true);
    for (const row of rows) {
      const table = String(row.resourceType) === 'document' ? documents : files;
      const [target] = await ctx.db
        .select({ id: table.id, parentId: table.parentId })
        .from(table)
        .where(
          and(
            eq(table.id, row.resourceId),
            eq(table.userId, root.userId),
            isNull(table.workspaceId),
          ),
        );
      if (!target) throw new TRPCError({ code: 'NOT_FOUND' });
      if (target.parentId && !ids.includes(target.parentId)) {
        const [parent] = await ctx.db
          .select({ deleted: documents.isDeleted })
          .from(documents)
          .where(eq(documents.id, target.parentId));
        if (parent?.deleted)
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'Restore the parent folder first',
          });
      }
      await ctx.db
        .update(table)
        .set(restoreStamp())
        .where(
          and(
            eq(table.id, row.resourceId),
            eq(table.userId, root.userId),
            isNull(table.workspaceId),
          ),
        );
    }
  },
  purge: async (ctx, root, children) => {
    const rows = [root, ...children];
    await resolveItemsScope(
      { serverDB: ctx.db, userId: ctx.userId },
      rows.map((row) => row.resourceId),
      'owner',
      true,
    );
    // Restore only inside this transaction so existing, scope-checked physical deletion can reuse
    // its complete reference/global-object bookkeeping. Other requests never see these rows live.
    const removed = await ctx.db.transaction(async (tx) => {
      const db = tx as unknown as LobeChatDatabase;
      const fileIds = rows
        .filter((row) => String(row.resourceType) === 'file')
        .map((row) => row.resourceId);
      if (fileIds.length)
        await db
          .update(files)
          .set(restoreStamp())
          .where(
            and(
              inArray(files.id, fileIds),
              eq(files.userId, root.userId),
              isNull(files.workspaceId),
            ),
          );
      const removed = await new FileModel(db, root.userId).deleteMany(fileIds);
      const docIds = rows
        .filter((row) => String(row.resourceType) === 'document')
        .map((row) => row.resourceId);
      if (docIds.length)
        await db
          .delete(documents)
          .where(
            and(
              inArray(documents.id, docIds),
              eq(documents.userId, root.userId),
              isNull(documents.workspaceId),
            ),
          );
      return removed;
    });
    if (removed.length)
      await ctx.fileService.deleteFiles(removed.map((file) => file.url!).filter(Boolean));
  },
};

/** Registry ids are not content ids. Resolve them before choosing an owner's recycle-bin scope. */
export const resolveEnterpriseTrashScope = async (ctx: EnterpriseAccessCtx, ids: string[]) => {
  const rows = await ctx.serverDB.select().from(trashItems).where(inArray(trashItems.id, ids));
  const content = rows.filter((row) => ['document', 'file'].includes(String(row.resourceType)));
  if (!content.length) return { enterprise: false as const };
  if (content.length !== new Set(ids).size) throw new TRPCError({ code: 'NOT_FOUND' });
  return resolveItemsScope(
    ctx,
    content.map((row) => row.resourceId),
    'owner',
    true,
  );
};

import { removeEnterpriseKbNodePolicies } from '@lobechat/business-knowledge';
import { TRASH_RETENTION_MS } from '@lobechat/const';
import { TRPCError } from '@trpc/server';
import { and, eq, inArray, isNull, notInArray, or, sql } from 'drizzle-orm';

import { FileModel } from '@/database/models/file';
import { documents, files, type TrashItemRow, trashItems } from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';
import { isTrashed, restoreStamp, trashStamp } from '@/database/utils/softDelete';
import { type TrashHandler, TrashRestoreError } from '@/server/services/trash/handlers/types';

import {
  type EnterpriseAccessCtx,
  type EnterpriseScope,
  itemsBelongToKnowledgeBase,
  resolveItemsScope,
  resolveKnowledgeBaseScope,
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
    // Each requested item is its own recycle-bin root; its cascade hangs under that root only.
    const pending = [...new Set(ids)].map((id) => ({ id, origin: id }));
    const visited = new Set<string>();
    const roots = new Map<string, string>();
    // Collect and authorize the whole live cascade before any row changes, so a child's
    // policy is judged against its live parent rather than one this cascade just trashed.
    const cascade: {
      doc?: typeof documents.$inferSelect;
      file?: typeof files.$inferSelect;
      id: string;
      origin: string;
    }[] = [];
    while (pending.length) {
      const { id, origin } = pending.shift()!;
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
        pending.push(...[...children, ...childFiles].map((row) => ({ id: row.id, origin })));
      }
      if (doc?.fileId) pending.push({ id: doc.fileId, origin });
      if (file) {
        const derived = await db
          .select({ id: documents.id })
          .from(documents)
          .where(eq(documents.fileId, file.id));
        pending.push(...derived.map((row) => ({ id: row.id, origin })));
      }
      // A folder edit grant must not cascade into a separately restricted child.
      await resolveKnowledgeBaseScope({ ...ctx, serverDB: db }, scope.knowledgeBaseId, 'edit', id);
      cascade.push({ doc, file, id, origin });
    }
    for (const { doc, file, id, origin } of cascade) {
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
          rootId: id === origin ? null : (roots.get(origin) ?? null),
        })
        .onConflictDoNothing()
        .returning({ id: trashItems.id });
      if (root && id === origin) roots.set(origin, root.id);
    }
    return { count: new Set(ids).size };
  });

/** Remove the registry in the same transaction as a governance restore or hard delete. */
export const removeEnterpriseTrashEntries = async (
  db: LobeChatDatabase,
  scope: Pick<EnterpriseScope, 'knowledgeBaseId' | 'ownerId'>,
  resources: { documentIds: string[]; fileIds: string[] },
) => {
  const mirrors = resources.fileIds.length
    ? await db
        .select({ id: documents.id })
        .from(documents)
        .where(
          and(
            inArray(documents.fileId, resources.fileIds),
            eq(documents.userId, scope.ownerId),
            isNull(documents.workspaceId),
            or(
              eq(documents.knowledgeBaseId, scope.knowledgeBaseId),
              eq(documents.sourceType, 'file'),
            ),
          ),
        )
    : [];
  const documentIds = [...resources.documentIds, ...mirrors.map((row) => row.id)];
  if (!resources.fileIds.length && !documentIds.length) return;
  const rows = await db
    .select({ id: trashItems.id })
    .from(trashItems)
    .where(
      and(
        eq(trashItems.userId, scope.ownerId),
        isNull(trashItems.workspaceId),
        or(
          resources.fileIds.length
            ? and(
                eq(trashItems.resourceType, sql`${'file'}`),
                inArray(trashItems.resourceId, resources.fileIds),
              )
            : undefined,
          documentIds.length
            ? and(
                eq(trashItems.resourceType, sql`${'document'}`),
                inArray(trashItems.resourceId, documentIds),
              )
            : undefined,
        ),
      ),
    );
  const ids = rows.map((row) => row.id);
  if (!ids.length) return;
  // A shared resource retained by another library must survive deletion of this root.
  await db
    .update(trashItems)
    .set({ rootId: null })
    .where(and(inArray(trashItems.rootId, ids), notInArray(trashItems.id, ids)));
  await db.delete(trashItems).where(inArray(trashItems.id, ids));
};

/** Restore the exact registry cascade after the caller verifies its owner/library scope. */
export const restoreEnterpriseTrashRows = async (
  db: LobeChatDatabase,
  ownerId: string,
  rows: TrashItemRow[],
) => {
  const ids = rows.map((row) => row.resourceId);
  for (const row of rows) {
    const table = String(row.resourceType) === 'document' ? documents : files;
    const [target] = await db
      .select({ id: table.id, parentId: table.parentId })
      .from(table)
      .where(
        and(eq(table.id, row.resourceId), eq(table.userId, ownerId), isNull(table.workspaceId)),
      );
    if (!target) throw new TrashRestoreError('notFound');
    if (target.parentId && !ids.includes(target.parentId)) {
      const [parent] = await db
        .select({ deleted: documents.isDeleted })
        .from(documents)
        .where(eq(documents.id, target.parentId));
      if (parent?.deleted) throw new TrashRestoreError('parentTrashed');
    }
    await db
      .update(table)
      .set(restoreStamp())
      .where(
        and(eq(table.id, row.resourceId), eq(table.userId, ownerId), isNull(table.workspaceId)),
      );
  }
};

export const enterpriseContentTrashHandler: Pick<TrashHandler, 'restore' | 'purge'> = {
  restore: async (ctx, root, children) => {
    const rows = [root, ...children];
    const ids = rows.map((row) => row.resourceId);
    await resolveItemsScope({ serverDB: ctx.db, userId: ctx.userId }, ids, 'owner', true);
    await restoreEnterpriseTrashRows(ctx.db, root.userId, rows);
  },
  purge: async (ctx, root, children) => {
    const rows = [root, ...children];
    // Restore only inside this transaction so existing, scope-checked physical deletion can reuse
    // its complete reference/global-object bookkeeping. Other requests never see these rows live.
    const removed = await ctx.db.transaction(async (tx) => {
      const db = tx as unknown as LobeChatDatabase;
      const scope = await resolveItemsScope(
        { serverDB: db, userId: ctx.userId },
        rows.map((row) => row.resourceId),
        'owner',
        true,
      );
      const table = String(root.resourceType) === 'document' ? documents : files;
      const [target] = await db
        .select({ deleted: table.isDeleted })
        .from(table)
        .where(
          and(
            eq(table.id, root.resourceId),
            eq(table.userId, root.userId),
            isNull(table.workspaceId),
          ),
        );
      // A registry snapshot can outlive a restore. It must never authorize deleting live content.
      if (!target?.deleted) return [];
      const fileIds = rows
        .filter((row) => String(row.resourceType) === 'file')
        .map((row) => row.resourceId);
      const deletedFiles = fileIds.length
        ? await db
            .update(files)
            .set(restoreStamp())
            .where(
              and(
                inArray(files.id, fileIds),
                eq(files.userId, root.userId),
                isNull(files.workspaceId),
                isTrashed(files.isDeleted),
              ),
            )
            .returning({ id: files.id })
        : [];
      const removed = await new FileModel(db, root.userId).deleteMany(
        deletedFiles.map((row) => row.id),
      );
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
              isTrashed(documents.isDeleted),
            ),
          );
      if (scope.enterprise)
        await removeEnterpriseKbNodePolicies(db, {
          knowledgeBaseId: scope.knowledgeBaseId,
          nodeIds: rows.map((row) => row.resourceId),
        });
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

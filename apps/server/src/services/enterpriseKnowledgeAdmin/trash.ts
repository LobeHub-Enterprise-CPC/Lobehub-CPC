import { randomUUID } from 'node:crypto';

import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';

import { TrashModel } from '@/database/models/trash';
import { documents, trashItems } from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';
import {
  type EnterpriseScope,
  itemsBelongToKnowledgeBase,
} from '@/server/services/enterpriseKnowledge';
import { restoreEnterpriseTrashRows } from '@/server/services/enterpriseKnowledge/trash';

import { notFound } from './errors';

/** Governance addresses content ids; frontend addresses registry ids. Both restore the same cascade. */
export const restoreEnterpriseTrashItem = async (
  db: LobeChatDatabase,
  scope: Pick<EnterpriseScope, 'knowledgeBaseId' | 'ownerId'>,
  resourceIds: string[],
) => {
  const entries = await db
    .select()
    .from(trashItems)
    .where(
      and(
        eq(trashItems.userId, scope.ownerId),
        isNull(trashItems.workspaceId),
        inArray(trashItems.resourceId, resourceIds),
        or(
          eq(trashItems.resourceType, sql`${'file'}`),
          eq(trashItems.resourceType, sql`${'document'}`),
        ),
      ),
    );
  if (!entries.length) throw notFound('Item');
  const registry = new TrashModel(db, scope.ownerId);
  // A parsed document can be the root while governance addresses its physical file child.
  // Follow the recorded deletion graph, never infer mirror membership from timestamps/fileId.
  const root = entries.find((row) => !row.rootId) ?? (await registry.findById(entries[0].rootId!));
  if (!root || root.rootId) throw notFound('Item');
  const rows = [root, ...(await registry.findChildren(root.id))];
  if (
    rows.some(
      (row) =>
        row.userId !== scope.ownerId ||
        row.workspaceId !== null ||
        !['file', 'document'].includes(row.resourceType),
    ) ||
    !(await itemsBelongToKnowledgeBase(
      db,
      rows.map((row) => row.resourceId),
      scope.knowledgeBaseId,
    ))
  )
    throw notFound('Item');
  await restoreEnterpriseTrashRows(db, scope.ownerId, rows);
  await registry.removeByIds(rows.map((row) => row.id));
};

/** Transfer the existing registry graph alongside content, remapping shared copies in this transaction. */
export const transferEnterpriseTrashEntries = async (
  db: LobeChatDatabase,
  params: {
    copiedResources: Map<string, string>;
    documentIds: string[];
    fileIds: string[];
    fromUserId: string;
    toUserId: string;
  },
) => {
  if (!params.fileIds.length && !params.documentIds.length) return;
  const rows = await db
    .select()
    .from(trashItems)
    .where(
      and(
        eq(trashItems.userId, params.fromUserId),
        isNull(trashItems.workspaceId),
        or(
          params.fileIds.length
            ? and(
                eq(trashItems.resourceType, sql`${'file'}`),
                inArray(trashItems.resourceId, params.fileIds),
              )
            : undefined,
          params.documentIds.length
            ? and(
                eq(trashItems.resourceType, sql`${'document'}`),
                inArray(trashItems.resourceId, params.documentIds),
              )
            : undefined,
        ),
      ),
    );
  const copied = rows.filter((row) =>
    params.copiedResources.has(`${row.resourceType}:${row.resourceId}`),
  );
  const registryIds = new Map(
    rows.map((row) => [row.id, copied.includes(row) ? randomUUID() : row.id]),
  );
  // Insert as roots first, then attach edges: a copied child may reference a copied root not yet inserted.
  for (const row of copied) {
    await db.insert(trashItems).values({
      ...row,
      id: registryIds.get(row.id)!,
      rootId: null,
      resourceId: params.copiedResources.get(`${row.resourceType}:${row.resourceId}`)!,
      userId: params.toUserId,
    });
  }
  for (const row of rows) {
    await db
      .update(trashItems)
      .set({
        rootId: row.rootId ? (registryIds.get(row.rootId) ?? null) : null,
        userId: params.toUserId,
      })
      .where(eq(trashItems.id, registryIds.get(row.id)!));
  }
  // Originals still referenced elsewhere keep their own recycle entries. Detach from moved folders,
  // grouping a retained mirror with its retained file so restoring one also restores its parsed view.
  const copiedRegistryIds = new Set(copied.map((row) => row.id));
  const fileRoots = new Map(
    copied
      .filter((row) => String(row.resourceType) === 'file')
      .map((row) => [row.resourceId, row.id]),
  );
  for (const row of copied) {
    if (!row.rootId || copiedRegistryIds.has(row.rootId)) continue;
    let rootId: string | null = null;
    if (String(row.resourceType) === 'document') {
      const [doc] = await db
        .select({ fileId: documents.fileId })
        .from(documents)
        .where(eq(documents.id, row.resourceId));
      rootId = doc?.fileId ? (fileRoots.get(doc.fileId) ?? null) : null;
    }
    await db.update(trashItems).set({ rootId }).where(eq(trashItems.id, row.id));
  }
};

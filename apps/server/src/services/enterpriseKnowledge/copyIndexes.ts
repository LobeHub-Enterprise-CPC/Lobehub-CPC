import { eq, inArray } from 'drizzle-orm';

import {
  chunks,
  documentChunks,
  documentHistories,
  embeddings,
  fileChunks,
  unstructuredChunks,
} from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';

/** Shared by member moves and governance owner transfers. Each scope owns its own index graph. */
export const copyContentIndexes = async (
  db: LobeChatDatabase,
  params: { documentMap: Map<string, string>; fileMap: Map<string, string>; toUserId: string },
) => {
  const { documentMap, fileMap } = params;
  const owner = { userId: params.toUserId, workspaceId: null, clientId: null };
  for (const [sourceId, targetId] of documentMap) {
    const histories = await db
      .select()
      .from(documentHistories)
      .where(eq(documentHistories.documentId, sourceId));
    for (const history of histories)
      await db
        .insert(documentHistories)
        .values({ ...history, id: undefined, ...owner, documentId: targetId });
  }
  const fileLinks = fileMap.size
    ? await db
        .select()
        .from(fileChunks)
        .where(inArray(fileChunks.fileId, [...fileMap.keys()]))
    : [];
  const docLinks = documentMap.size
    ? await db
        .select()
        .from(documentChunks)
        .where(inArray(documentChunks.documentId, [...documentMap.keys()]))
    : [];
  const chunkIds = [
    ...new Set(
      [...fileLinks, ...docLinks].map((row) => row.chunkId).filter((id): id is string => !!id),
    ),
  ];
  const chunkMap = new Map<string, string>();
  if (chunkIds.length) {
    const originals = await db.select().from(chunks).where(inArray(chunks.id, chunkIds));
    for (const original of originals) {
      const [copy] = await db
        .insert(chunks)
        .values({ ...original, id: undefined, ...owner })
        .returning();
      chunkMap.set(original.id, copy.id);
    }
    const vectors = await db.select().from(embeddings).where(inArray(embeddings.chunkId, chunkIds));
    for (const vector of vectors)
      await db
        .insert(embeddings)
        .values({ ...vector, id: undefined, ...owner, chunkId: chunkMap.get(vector.chunkId!)! });
  }
  for (const link of fileLinks)
    if (link.fileId && link.chunkId && chunkMap.has(link.chunkId))
      await db.insert(fileChunks).values({
        ...link,
        ...owner,
        fileId: fileMap.get(link.fileId)!,
        chunkId: chunkMap.get(link.chunkId)!,
      });
  for (const link of docLinks)
    await db.insert(documentChunks).values({
      ...link,
      ...owner,
      documentId: documentMap.get(link.documentId)!,
      chunkId: chunkMap.get(link.chunkId)!,
    });
  if (!fileMap.size) return;
  const unstructured = await db
    .select()
    .from(unstructuredChunks)
    .where(inArray(unstructuredChunks.fileId, [...fileMap.keys()]));
  const unstructuredMap = new Map<string, string>();
  for (const original of unstructured) {
    const [copy] = await db
      .insert(unstructuredChunks)
      .values({
        ...original,
        id: undefined,
        ...owner,
        fileId: fileMap.get(original.fileId!)!,
        parentId: null,
        compositeId: original.compositeId ? chunkMap.get(original.compositeId) : null,
      })
      .returning({ id: unstructuredChunks.id });
    unstructuredMap.set(original.id, copy.id);
  }
  for (const original of unstructured) {
    if (!original.parentId) continue;
    const parentId = unstructuredMap.get(original.parentId) ?? chunkMap.get(original.parentId);
    if (parentId)
      await db
        .update(unstructuredChunks)
        .set({ parentId })
        .where(eq(unstructuredChunks.id, unstructuredMap.get(original.id)!));
  }
};

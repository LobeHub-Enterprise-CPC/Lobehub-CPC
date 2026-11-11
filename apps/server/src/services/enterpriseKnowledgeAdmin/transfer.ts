import {
  getEnterpriseKbItemUploaders,
  recordEnterpriseKbItemUploaders,
} from '@lobechat/business-knowledge';
import { and, eq, inArray, isNull, ne, or } from 'drizzle-orm';
import { chunk } from 'es-toolkit/compat';

import { DocumentModel } from '@/database/models/document';
import { FileModel } from '@/database/models/file';
import {
  agentsFiles,
  asyncTasks,
  chunks,
  documentChunks,
  documentHistories,
  documents,
  embeddings,
  fileChunks,
  files,
  filesToSessions,
  knowledgeBaseFiles,
  messagesFiles,
  unstructuredChunks,
} from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';

/** References outside this library keep their original file and parsed content. */
export const findSharedFileIds = async (
  db: LobeChatDatabase,
  knowledgeBaseId: string,
  fileIds: string[],
): Promise<Set<string>> => {
  const shared = new Set<string>();
  for (const batch of chunk(fileIds, 5000)) {
    const references = [
      await db
        .select({ id: knowledgeBaseFiles.fileId })
        .from(knowledgeBaseFiles)
        .where(
          and(
            inArray(knowledgeBaseFiles.fileId, batch),
            ne(knowledgeBaseFiles.knowledgeBaseId, knowledgeBaseId),
          ),
        ),
      await db
        .select({ id: messagesFiles.fileId })
        .from(messagesFiles)
        .where(inArray(messagesFiles.fileId, batch)),
      await db
        .select({ id: filesToSessions.fileId })
        .from(filesToSessions)
        .where(inArray(filesToSessions.fileId, batch)),
      await db
        .select({ id: agentsFiles.fileId })
        .from(agentsFiles)
        .where(inArray(agentsFiles.fileId, batch)),
      // A parsed mirror is intrinsic to a file. Independent API/agent documents are personal references.
      await db
        .select({ id: documents.fileId })
        .from(documents)
        .where(
          and(
            inArray(documents.fileId, batch),
            ne(documents.sourceType, 'file'),
            or(ne(documents.knowledgeBaseId, knowledgeBaseId), isNull(documents.knowledgeBaseId)),
          ),
        ),
    ];
    for (const row of references.flat()) if (row.id) shared.add(row.id);
  }
  return shared;
};

/** Copy stored bytes by reference and duplicate the existing derived graph, without reprocessing. */
export const copySharedFiles = async (
  db: LobeChatDatabase,
  params: { fromUserId: string; knowledgeBaseId: string; shared: Set<string>; toUserId: string },
): Promise<Map<string, string>> => {
  const copiedIds = new Map<string, string>();
  const originalIds = [...params.shared];
  if (!originalIds.length) return copiedIds;
  const originals = await db
    .select()
    .from(files)
    .where(and(inArray(files.id, originalIds), eq(files.userId, params.fromUserId)));
  const uploaders = await getEnterpriseKbItemUploaders(db, originalIds);
  const libraryDocumentIds = new Set(
    (
      await db
        .select({ id: documents.id })
        .from(documents)
        .where(eq(documents.knowledgeBaseId, params.knowledgeBaseId))
    ).map((row) => row.id),
  );
  const owner = { userId: params.toUserId, workspaceId: null, clientId: null };
  for (const original of originals) {
    const taskMap = new Map<string, string>();
    for (const id of [original.chunkTaskId, original.embeddingTaskId]) {
      if (!id || taskMap.has(id)) continue;
      const [task] = await db
        .select()
        .from(asyncTasks)
        .where(and(eq(asyncTasks.id, id), eq(asyncTasks.userId, params.fromUserId)));
      if (!task) continue;
      const [copy] = await db
        .insert(asyncTasks)
        .values({ ...task, id: undefined, ...owner })
        .returning();
      taskMap.set(id, copy.id);
    }
    const copy = await new FileModel(db, params.toUserId).create({
      ...original,
      id: undefined,
      workspaceId: null,
      clientId: null,
      parentId: original.parentId ?? undefined,
      knowledgeBaseId: params.knowledgeBaseId,
      chunkTaskId: original.chunkTaskId ? taskMap.get(original.chunkTaskId) : null,
      embeddingTaskId: original.embeddingTaskId ? taskMap.get(original.embeddingTaskId) : null,
    });
    copiedIds.set(`file:${original.id}`, copy.id);
    if (original.parentId && libraryDocumentIds.has(original.parentId))
      await db.update(files).set({ parentId: null }).where(eq(files.id, original.id));
    await db
      .delete(knowledgeBaseFiles)
      .where(
        and(
          eq(knowledgeBaseFiles.knowledgeBaseId, params.knowledgeBaseId),
          eq(knowledgeBaseFiles.fileId, original.id),
        ),
      );
    if (uploaders[original.id])
      await recordEnterpriseKbItemUploaders(db, [
        { actor: uploaders[original.id], itemId: copy.id, knowledgeBaseId: params.knowledgeBaseId },
      ]);

    const mirrors = await db
      .select()
      .from(documents)
      .where(
        and(
          eq(documents.fileId, original.id),
          eq(documents.userId, params.fromUserId),
          or(
            eq(documents.sourceType, 'file'),
            eq(documents.knowledgeBaseId, params.knowledgeBaseId),
          ),
        ),
      );
    const documentMap = new Map<string, string>();
    for (const mirror of mirrors) {
      const cloned = await new DocumentModel(db, params.toUserId).create({
        ...mirror,
        id: undefined,
        slug: undefined,
        clientId: null,
        workspaceId: null,
        fileId: copy.id,
        knowledgeBaseId: params.knowledgeBaseId,
      });
      documentMap.set(mirror.id, cloned.id);
      copiedIds.set(`document:${mirror.id}`, cloned.id);
      // Its original parsed view stays with other references of the original file.
      if (mirror.knowledgeBaseId === params.knowledgeBaseId) {
        await db
          .update(documents)
          .set({ knowledgeBaseId: null, parentId: null })
          .where(eq(documents.id, mirror.id));
      } else if (mirror.parentId && libraryDocumentIds.has(mirror.parentId)) {
        await db.update(documents).set({ parentId: null }).where(eq(documents.id, mirror.id));
      }
      const histories = await db
        .select()
        .from(documentHistories)
        .where(eq(documentHistories.documentId, mirror.id));
      for (const history of histories)
        await db
          .insert(documentHistories)
          .values({ ...history, id: undefined, ...owner, documentId: cloned.id });
    }
    const fileLinks = await db.select().from(fileChunks).where(eq(fileChunks.fileId, original.id));
    const docLinks = documentMap.size
      ? await db
          .select()
          .from(documentChunks)
          .where(inArray(documentChunks.documentId, [...documentMap.keys()]))
      : [];
    const chunkIds = [
      ...new Set(
        [...fileLinks.map((link) => link.chunkId), ...docLinks.map((link) => link.chunkId)].filter(
          (id): id is string => !!id,
        ),
      ),
    ];
    const chunkMap = new Map<string, string>();
    if (chunkIds.length) {
      const oldChunks = await db.select().from(chunks).where(inArray(chunks.id, chunkIds));
      for (const old of oldChunks) {
        const [copied] = await db
          .insert(chunks)
          .values({ ...old, id: undefined, ...owner })
          .returning();
        chunkMap.set(old.id, copied.id);
      }
      const oldEmbeddings = await db
        .select()
        .from(embeddings)
        .where(inArray(embeddings.chunkId, chunkIds));
      for (const embedding of oldEmbeddings)
        await db.insert(embeddings).values({
          ...embedding,
          id: undefined,
          ...owner,
          chunkId: chunkMap.get(embedding.chunkId!)!,
        });
    }
    for (const link of fileLinks)
      if (link.chunkId && chunkMap.has(link.chunkId))
        await db
          .insert(fileChunks)
          .values({ ...link, ...owner, fileId: copy.id, chunkId: chunkMap.get(link.chunkId)! });
    for (const link of docLinks)
      await db.insert(documentChunks).values({
        ...link,
        ...owner,
        documentId: documentMap.get(link.documentId)!,
        chunkId: chunkMap.get(link.chunkId)!,
      });
    const unstructured = await db
      .select()
      .from(unstructuredChunks)
      .where(eq(unstructuredChunks.fileId, original.id));
    for (const row of unstructured)
      await db.insert(unstructuredChunks).values({
        ...row,
        id: undefined,
        ...owner,
        fileId: copy.id,
        compositeId: row.compositeId ? chunkMap.get(row.compositeId) : null,
      });
  }
  return copiedIds;
};

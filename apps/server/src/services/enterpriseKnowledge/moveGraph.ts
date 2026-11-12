import { TRPCError } from '@trpc/server';
import { and, eq, isNull } from 'drizzle-orm';
import { omit } from 'es-toolkit';

import { DocumentModel } from '@/database/models/document';
import { FileModel } from '@/database/models/file';
import { asyncTasks, documents, files, knowledgeBaseFiles } from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';
import {
  deriveStatus,
  isProcessingStatus,
  toTaskState,
} from '@/server/services/enterpriseKnowledgeAdmin/status';

import { copyContentIndexes } from './copyIndexes';

export interface MoveGraph {
  documents: Map<string, typeof documents.$inferSelect>;
  files: Map<string, typeof files.$inferSelect>;
  roots: string[];
}

/** Collect all owned live content, including file mirrors and authored-page backing files. */
export const loadMoveGraph = async (
  db: LobeChatDatabase,
  userId: string,
  ids: string[],
): Promise<MoveGraph> => {
  const graph: MoveGraph = { documents: new Map(), files: new Map(), roots: [] };
  const docModel = new DocumentModel(db, userId);
  const fileModel = new FileModel(db, userId);
  const pending = [...new Set(ids)];
  const rootIds = new Set(pending);
  const seen = new Set<string>();
  while (pending.length) {
    const id = pending.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const [rawDoc] = await db
      .select()
      .from(documents)
      .where(and(eq(documents.id, id), eq(documents.userId, userId), isNull(documents.workspaceId)))
      .for('update');
    const [rawFile] = rawDoc
      ? []
      : await db
          .select()
          .from(files)
          .where(and(eq(files.id, id), eq(files.userId, userId), isNull(files.workspaceId)))
          .for('update');
    const raw = rawDoc ?? rawFile;
    if (!raw || raw.userId !== userId || raw.workspaceId || (raw.isDeleted && rootIds.has(id)))
      throw new TRPCError({ code: 'NOT_FOUND' });
    if (raw.isDeleted) continue;
    // Preserve ordinary resource visibility/provenance guards, including private visitor uploads.
    if (rawDoc) {
      if (!(await docModel.findById(id))) throw new TRPCError({ code: 'NOT_FOUND' });
      graph.documents.set(id, rawDoc);
      if (rawDoc.fileId) pending.push(rawDoc.fileId);
      if (rawDoc.fileType === 'custom/folder') {
        const children = await db
          .select({ id: documents.id })
          .from(documents)
          .where(eq(documents.parentId, id));
        const childFiles = await db
          .select({ id: files.id })
          .from(files)
          .where(eq(files.parentId, id));
        pending.push(...children.map((r) => r.id), ...childFiles.map((r) => r.id));
      }
    } else {
      if (!(await fileModel.findById(id))) throw new TRPCError({ code: 'NOT_FOUND' });
      graph.files.set(id, rawFile!);
      const mirrors = await db
        .select({ id: documents.id })
        .from(documents)
        .where(eq(documents.fileId, id));
      pending.push(...mirrors.map((r) => r.id));
    }
  }
  const authoredByFile = new Map(
    [...graph.documents.values()]
      // Every page authored in the library (markdown, HTML, ...) owns its backing file; only
      // parsed mirrors (`sourceType: 'file'`) follow the file instead.
      .filter((row) => row.fileId && row.sourceType !== 'file')
      .map((row) => [row.fileId!, row.id]),
  );
  const canonical = (id: string) => {
    const doc = graph.documents.get(id);
    const fileId = doc?.sourceType === 'file' ? doc.fileId : graph.files.has(id) ? id : null;
    return fileId ? (authoredByFile.get(fileId) ?? fileId) : id;
  };
  const canonicalRoots = new Set(ids.map(canonical));
  graph.roots = [...canonicalRoots].filter((id) => {
    const row = graph.documents.get(id) ?? graph.files.get(id)!;
    let parentId = row.parentId;
    const parents = new Set<string>([id]);
    while (parentId) {
      if (parents.has(parentId))
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid folder hierarchy' });
      if (canonicalRoots.has(parentId)) return false;
      parents.add(parentId);
      parentId = graph.documents.get(parentId)?.parentId ?? null;
    }
    return true;
  });
  return graph;
};

/** Copy the complete graph using the existing models and the governance index-copy pipeline. */
export const copyMoveGraph = async (
  db: LobeChatDatabase,
  graph: MoveGraph,
  target: { knowledgeBaseId: string | null; parentId: string | null; userId: string },
) => {
  const fileMap = new Map<string, string>();
  const documentMap = new Map<string, string>();
  const taskMap = new Map<string, string>();
  const taskStates = new Map<string, string | null>();
  const ownership = { userId: target.userId, workspaceId: null };
  for (const file of graph.files.values()) {
    for (const taskId of [file.chunkTaskId, file.embeddingTaskId]) {
      if (!taskId || taskMap.has(taskId)) continue;
      const [task] = await db
        .select()
        .from(asyncTasks)
        .where(
          and(
            eq(asyncTasks.id, taskId),
            eq(asyncTasks.userId, file.userId),
            isNull(asyncTasks.workspaceId),
          ),
        );
      if (!task) continue;
      taskStates.set(taskId, task.status);
      // The running worker writes to the original file. A snapshot of it cannot finish for the copy.
      if (task.status === 'pending' || task.status === 'processing')
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'Wait for file processing to finish before moving it',
        });
      const [copy] = await db
        .insert(asyncTasks)
        .values({ ...task, id: undefined, ...ownership, parentId: null, inferenceId: null })
        .returning();
      taskMap.set(taskId, copy.id);
    }
    const status = deriveStatus(
      toTaskState(file.chunkTaskId ? taskStates.get(file.chunkTaskId) : null),
      toTaskState(file.embeddingTaskId ? taskStates.get(file.embeddingTaskId) : null),
    );
    if (isProcessingStatus(status.status))
      throw new TRPCError({
        code: 'CONFLICT',
        message: 'Wait for file processing to finish before moving it',
      });
    const { fileId } = await new FileModel(db, file.userId).copyToWorkspace(
      file.id,
      null,
      target.userId,
    );
    fileMap.set(file.id, fileId);
    await db
      .update(files)
      .set({
        visibility: 'private',
        chunkTaskId: file.chunkTaskId ? (taskMap.get(file.chunkTaskId) ?? null) : null,
        embeddingTaskId: file.embeddingTaskId ? (taskMap.get(file.embeddingTaskId) ?? null) : null,
      })
      .where(eq(files.id, fileId));
    if (target.knowledgeBaseId)
      await db
        .insert(knowledgeBaseFiles)
        .values({ ...ownership, knowledgeBaseId: target.knowledgeBaseId, fileId });
  }
  let pending = [...graph.documents.values()];
  while (pending.length) {
    const ready = pending.filter(
      (doc) => !doc.parentId || !graph.documents.has(doc.parentId) || documentMap.has(doc.parentId),
    );
    if (!ready.length)
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid folder hierarchy' });
    for (const doc of ready) {
      const copy = await new DocumentModel(db, target.userId).create({
        ...doc,
        id: undefined,
        slug: undefined,
        clientId: null,
        workspaceId: null,
        visibility: 'private',
        fileId: doc.fileId ? fileMap.get(doc.fileId)! : null,
        knowledgeBaseId: target.knowledgeBaseId,
        parentId: doc.parentId
          ? (documentMap.get(doc.parentId) ?? target.parentId)
          : target.parentId,
        metadata: {
          ...omit(doc.metadata ?? {}, ['knowledgeBaseId']),
          ...(target.knowledgeBaseId && doc.fileType === 'custom/folder'
            ? { knowledgeBaseId: target.knowledgeBaseId }
            : {}),
          duplicatedFrom: doc.id,
        },
      });
      documentMap.set(doc.id, copy.id);
    }
    pending = pending.filter((doc) => !documentMap.has(doc.id));
  }
  for (const file of graph.files.values())
    await db
      .update(files)
      .set({
        parentId: file.parentId
          ? (documentMap.get(file.parentId) ?? target.parentId)
          : target.parentId,
      })
      .where(eq(files.id, fileMap.get(file.id)!));
  await copyContentIndexes(db, { documentMap, fileMap, toUserId: target.userId });
  return { documentMap, fileMap };
};

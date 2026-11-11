import type { EnterpriseKbActor } from '@lobechat/business-knowledge';
import { getEnterpriseKbItemUploaders } from '@lobechat/business-knowledge';
import { isRecord } from '@lobechat/utils/object';
import { and, count, eq, inArray, isNull, or } from 'drizzle-orm';

import {
  DOCUMENT_FOLDER_TYPE,
  type DocumentItem,
  documents,
  fileChunks,
  type FileItem,
  files,
  knowledgeBaseFiles,
} from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';

import { invalidRequest, notFound } from './errors';
import {
  type ContentStatus,
  deriveStatus,
  describeTaskError,
  type StatusStage,
  toTaskState,
} from './status';
import { chunkTask, embeddingTask } from './tasks';

export interface ContentItem {
  childCount: number | null;
  chunkCount: number | null;
  createdAt: string;
  fileType: string | null;
  id: string;
  kind: 'document' | 'file' | 'folder';
  name: string;
  parentId: string | null;
  size: number | null;
  status: ContentStatus;
  statusDetail: {
    message: string | null;
    progress: { done: number; total: number } | null;
    stage: StatusStage;
  };
  updatedAt: string;
  uploader: EnterpriseKbActor | null;
}

export interface ContentRecord {
  document?: Pick<
    DocumentItem,
    | 'id'
    | 'fileId'
    | 'fileType'
    | 'filename'
    | 'title'
    | 'parentId'
    | 'sourceType'
    | 'knowledgeBaseId'
    | 'isDeleted'
    | 'deletedAt'
    | 'createdAt'
    | 'updatedAt'
  >;
  file?: FileItem;
  item: ContentItem;
  trashed: boolean;
}

/** The KB membership and owner predicates are applied before exposing or mutating any ID. */
export const loadContent = async (
  db: LobeChatDatabase,
  kb: { id: string; userId: string },
): Promise<ContentRecord[]> => {
  const fileRows = await db
    .select({
      file: files,
      chunkStatus: chunkTask.status,
      chunkError: chunkTask.error,
      embeddingStatus: embeddingTask.status,
      embeddingError: embeddingTask.error,
    })
    .from(files)
    .innerJoin(
      knowledgeBaseFiles,
      and(
        eq(knowledgeBaseFiles.fileId, files.id),
        eq(knowledgeBaseFiles.knowledgeBaseId, kb.id),
        eq(knowledgeBaseFiles.userId, kb.userId),
        isNull(knowledgeBaseFiles.workspaceId),
      ),
    )
    .leftJoin(chunkTask, and(eq(chunkTask.id, files.chunkTaskId), eq(chunkTask.userId, kb.userId)))
    .leftJoin(
      embeddingTask,
      and(eq(embeddingTask.id, files.embeddingTaskId), eq(embeddingTask.userId, kb.userId)),
    )
    .where(and(eq(files.userId, kb.userId), isNull(files.workspaceId)));
  const linkedIds = fileRows.map((row) => row.file.id);
  const docRows = await db
    .select({
      id: documents.id,
      fileId: documents.fileId,
      fileType: documents.fileType,
      filename: documents.filename,
      title: documents.title,
      parentId: documents.parentId,
      sourceType: documents.sourceType,
      knowledgeBaseId: documents.knowledgeBaseId,
      isDeleted: documents.isDeleted,
      deletedAt: documents.deletedAt,
      createdAt: documents.createdAt,
      updatedAt: documents.updatedAt,
    })
    .from(documents)
    .where(
      and(
        eq(documents.userId, kb.userId),
        isNull(documents.workspaceId),
        or(
          eq(documents.knowledgeBaseId, kb.id),
          linkedIds.length ? inArray(documents.fileId, linkedIds) : undefined,
        ),
      ),
    );
  // File-derived documents are mirrors of the file entry, not a second item in its folder.
  const standaloneDocs = docRows.filter((doc) => !doc.fileId);
  const ids = [...linkedIds, ...docRows.map((doc) => doc.id)];
  const uploaders = await getEnterpriseKbItemUploaders(db, ids);
  const chunkCounts = linkedIds.length
    ? await db
        .select({ id: fileChunks.fileId, total: count() })
        .from(fileChunks)
        .where(and(inArray(fileChunks.fileId, linkedIds), eq(fileChunks.userId, kb.userId)))
        .groupBy(fileChunks.fileId)
    : [];
  const counts = new Map(chunkCounts.map((row) => [row.id, row.total]));
  const nativeDocs = new Map(
    docRows
      .filter((doc) => doc.knowledgeBaseId === kb.id && doc.sourceType !== 'file' && doc.fileId)
      .map((doc) => [doc.fileId!, doc]),
  );
  const records: ContentRecord[] = fileRows.map(
    ({ file, chunkStatus, chunkError, embeddingStatus, embeddingError }) => {
      const native = nativeDocs.get(file.id);
      const state = native
        ? { status: 'none' as const, stage: null }
        : deriveStatus(toTaskState(chunkStatus), toTaskState(embeddingStatus));
      const error = state.stage === 'embedding' ? embeddingError : chunkError;
      return {
        file,
        document: native,
        trashed: file.isDeleted === true || native?.isDeleted === true,
        item: {
          id: native?.id ?? file.id,
          kind: native ? 'document' : 'file',
          name: native?.title ?? file.name,
          parentId: native?.parentId ?? file.parentId,
          size: file.size,
          fileType: file.fileType,
          childCount: null,
          chunkCount: counts.get(file.id) ?? 0,
          status: state.status,
          statusDetail: {
            stage: state.stage,
            message:
              state.status === 'error'
                ? describeTaskError(state.stage, isRecord(error) ? error : null)
                : null,
            progress: null,
          },
          uploader: uploaders[native?.id ?? file.id] ?? uploaders[file.id] ?? null,
          createdAt: file.createdAt.toISOString(),
          updatedAt: file.updatedAt.toISOString(),
        },
      };
    },
  );
  for (const doc of standaloneDocs) {
    records.push({
      document: doc,
      trashed: doc.isDeleted === true,
      item: {
        id: doc.id,
        kind: doc.fileType === DOCUMENT_FOLDER_TYPE ? 'folder' : 'document',
        name: doc.title ?? doc.filename ?? '',
        parentId: doc.parentId,
        size: null,
        fileType: doc.fileType,
        childCount: null,
        chunkCount: null,
        status: 'none',
        statusDetail: { stage: null, message: null, progress: null },
        uploader: uploaders[doc.id] ?? null,
        createdAt: doc.createdAt.toISOString(),
        updatedAt: doc.updatedAt.toISOString(),
      },
    });
  }
  for (const row of records) {
    if (row.item.kind === 'folder')
      row.item.childCount = records.filter(
        (child) => !child.trashed && child.item.parentId === row.item.id,
      ).length;
  }
  return records;
};

export const findContent = (
  records: ContentRecord[],
  id: string,
  trashed = false,
): ContentRecord => {
  const row = records.find((row) => row.item.id === id && row.trashed === trashed);
  if (!row) throw notFound('Item');
  return row;
};

/** Returns ancestors root-first, and refuses a foreign, deleted or cyclic parent chain. */
export const breadcrumbFor = (
  rows: ContentRecord[],
  parentId?: string | null,
): { id: string; name: string }[] => {
  const result: { id: string; name: string }[] = [];
  const visited = new Set<string>();
  let id = parentId;
  while (id) {
    if (visited.has(id)) throw invalidRequest('不能将文件夹移入自身或下级目录。');
    visited.add(id);
    const row = findContent(rows, id);
    if (row.item.kind !== 'folder') throw invalidRequest('上级条目必须是文件夹。');
    result.unshift({ id, name: row.item.name });
    id = row.item.parentId;
  }
  return result;
};

export const subtreeOf = (rows: ContentRecord[], root: ContentRecord): ContentRecord[] => {
  const selected = new Set([root.item.id]);
  let size = 0;
  while (selected.size !== size) {
    size = selected.size;
    for (const row of rows)
      if (row.item.parentId && selected.has(row.item.parentId)) selected.add(row.item.id);
  }
  return rows.filter((row) => selected.has(row.item.id));
};

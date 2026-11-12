import { randomUUID } from 'node:crypto';

import {
  recordEnterpriseKbItemUploaders,
  removeEnterpriseKbItemUploaders,
  removeEnterpriseKbNodePolicies,
} from '@lobechat/business-knowledge';
import { and, eq, inArray, isNull, or } from 'drizzle-orm';

import { serverDBEnv } from '@/config/db';
import { DocumentModel } from '@/database/models/document';
import { FileModel } from '@/database/models/file';
import { DOCUMENT_FOLDER_TYPE, documents, files, fileUploads } from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';
import type { trashStamp } from '@/database/utils/softDelete';
import { restoreStamp } from '@/database/utils/softDelete';
import { ChunkService } from '@/server/services/chunk';
import {
  removeEnterpriseTrashEntries,
  trashEnterpriseItems,
} from '@/server/services/enterpriseKnowledge/trash';
import { FileService } from '@/server/services/file';
import { FileUploadService } from '@/server/services/fileUpload';
import { reserveUpload } from '@/server/services/fileUploadReservation';

import {
  breadcrumbFor,
  type ContentRecord,
  findContent,
  loadContent,
  subtreeOf,
} from './contentData';
import { invalidRequest } from './errors';
import { orphanedHashlessKeys } from './libraries';
import { type AdminActor, loadEnterpriseKb, lockEnterpriseKb, toEnterpriseActor } from './shared';
import { isProcessingStatus } from './status';
import { restoreEnterpriseTrashItem } from './trash';

interface UploadInput {
  contentType: string;
  name: string;
  size: number;
}
interface PageInput {
  page: number;
  pageSize: number;
}

export class EnterpriseKbContentService {
  constructor(private readonly db: LobeChatDatabase) {}

  list = async (
    id: string,
    params: PageInput & { parentId?: string; q?: string; status: 'all' | 'failed' | 'processing' },
  ) => {
    const kb = await loadEnterpriseKb(this.db, id);
    const rows = await loadContent(this.db, kb);
    const breadcrumb = breadcrumbFor(rows, params.parentId);
    const live = rows.filter((row) => !row.trashed);
    const counts = {
      failed: live.filter((row) => row.item.status === 'error').length,
      processing: live.filter((row) => isProcessingStatus(row.item.status)).length,
    };
    const global = !!params.q || params.status !== 'all';
    const filtered = live.filter(
      ({ item }) =>
        (global || item.parentId === (params.parentId || null)) &&
        (!params.q || item.name.toLocaleLowerCase().includes(params.q.toLocaleLowerCase())) &&
        (params.status === 'all' ||
          (params.status === 'failed' ? item.status === 'error' : isProcessingStatus(item.status))),
    );
    return { ...this.page(filtered, params), counts, breadcrumb };
  };

  listTrash = async (id: string, params: PageInput) => {
    const kb = await loadEnterpriseKb(this.db, id);
    return this.page(
      (await loadContent(this.db, kb)).filter((row) => row.trashed),
      params,
    );
  };

  presign = async (id: string, input: UploadInput) => {
    const kb = await loadEnterpriseKb(this.db, id);
    const key = `files/${kb.userId}/enterprise-kb/${id}/${randomUUID()}/${encodeURIComponent(input.name)}`;
    const service = new FileService(this.db, kb.userId);
    const uploads = new FileUploadService(this.db, kb.userId);
    const reservation = await reserveUpload({
      db: this.db,
      model: uploads.model,
      pathname: key,
      size: input.size,
      storage: service,
      userId: kb.userId,
    });
    if (!reservation) throw invalidRequest('上传预约失败，请重试。');
    try {
      const signed = await service.createPreSignedUpload(key);
      return { uploadUrl: signed.url, method: 'PUT' as const, headers: signed.headers ?? {}, key };
    } catch (error) {
      // No credentials were issued, so drop only this fresh reservation; no object exists yet.
      await this.db.delete(fileUploads).where(eq(fileUploads.id, reservation.id));
      throw error;
    }
  };

  register = async (
    id: string,
    input: UploadInput & {
      actor: AdminActor;
      hash?: string;
      key: string;
      parentId?: string | null;
    },
  ) => {
    const kb = await loadEnterpriseKb(this.db, id);
    const expectedPrefix = `files/${kb.userId}/enterprise-kb/${id}/`;
    if (!input.key.startsWith(expectedPrefix)) throw invalidRequest('上传文件不属于此知识库。');
    const rows = await loadContent(this.db, kb);
    breadcrumbFor(rows, input.parentId);
    const uploads = new FileUploadService(this.db, kb.userId);
    const active = await uploads.touchActive(input.key);
    if (!active || active.size !== input.size)
      throw invalidRequest('上传预约不存在或文件大小不匹配。');
    const storage = new FileService(this.db, kb.userId);
    let metadata: { contentLength: number; contentType?: string };
    try {
      metadata = await storage.getFileMetadata(input.key);
    } catch {
      throw invalidRequest('上传文件暂不可用，请重试。');
    }
    if (metadata.contentLength !== input.size) throw invalidRequest('上传文件大小不匹配。');
    const created = await this.db.transaction(async (tx) => {
      const trx = tx as unknown as LobeChatDatabase;
      await lockEnterpriseKb(trx, kb);
      breadcrumbFor(await loadContent(trx, kb), input.parentId);
      const locked = await uploads.model.findLatestByPathnameForUpdate(input.key, tx);
      if (!locked || locked.id !== active.id || locked.status !== 'active')
        throw invalidRequest('该上传已登记或已失效。');
      const model = new FileModel(trx, kb.userId);
      const result = await model.create(
        {
          name: input.name,
          fileType: input.contentType,
          fileHash: input.hash,
          size: metadata.contentLength,
          url: input.key,
          parentId: input.parentId ?? undefined,
          knowledgeBaseId: id,
        },
        !!input.hash,
        tx,
      );
      if (!(await uploads.model.settle(active.id, result.id, tx)))
        throw invalidRequest('文件登记失败，请重试。');
      await recordEnterpriseKbItemUploaders(tx, [
        { actor: toEnterpriseActor(input.actor), itemId: result.id, knowledgeBaseId: id },
      ]);
      return result;
    });
    await new ChunkService(this.db, kb.userId).asyncParseFileToChunks(created.id);
    return findContent(await loadContent(this.db, kb), created.id).item;
  };

  createFolder = async (
    id: string,
    input: { actor: AdminActor; name: string; parentId?: string | null },
  ) => {
    const kb = await loadEnterpriseKb(this.db, id);
    breadcrumbFor(await loadContent(this.db, kb), input.parentId);
    const created = await this.db.transaction(async (tx) => {
      const db = tx as unknown as LobeChatDatabase;
      await lockEnterpriseKb(db, kb);
      breadcrumbFor(await loadContent(db, kb), input.parentId);
      const model = new DocumentModel(db, kb.userId);
      const folder = await model.create({
        knowledgeBaseId: id,
        title: input.name,
        filename: input.name,
        parentId: input.parentId,
        fileType: DOCUMENT_FOLDER_TYPE,
        content: '',
        sourceType: 'api',
        source: '',
        totalCharCount: 0,
        totalLineCount: 0,
      });
      await recordEnterpriseKbItemUploaders(tx, [
        { actor: toEnterpriseActor(input.actor), itemId: folder.id, knowledgeBaseId: id },
      ]);
      return folder;
    });
    return findContent(await loadContent(this.db, kb), created.id).item;
  };

  update = async (
    id: string,
    itemId: string,
    input: { name?: string; parentId?: string | null },
  ) => {
    const kb = await loadEnterpriseKb(this.db, id);
    const rows = await loadContent(this.db, kb);
    const row = findContent(rows, itemId);
    const breadcrumb = breadcrumbFor(rows, input.parentId);
    if (breadcrumb.some((parent) => parent.id === itemId))
      throw invalidRequest('不能将文件夹移入自身或下级目录。');
    await this.db.transaction(async (tx) => {
      const db = tx as unknown as LobeChatDatabase;
      await lockEnterpriseKb(db, kb);
      const currentRows = await loadContent(db, kb);
      findContent(currentRows, itemId);
      const currentParents = breadcrumbFor(currentRows, input.parentId);
      if (currentParents.some((parent) => parent.id === itemId))
        throw invalidRequest('不能将文件夹移入自身或下级目录。');
      if (row.file) {
        await new FileModel(db, kb.userId).update(row.file.id, {
          name: input.name,
          parentId: input.parentId,
        });
        // Limit mirrors to this library; do not rewrite an agent's independent imported copy.
        const mirrors = await db
          .select({ id: documents.id })
          .from(documents)
          .where(
            and(
              eq(documents.fileId, row.file!.id),
              eq(documents.userId, kb.userId),
              or(eq(documents.knowledgeBaseId, id), eq(documents.sourceType, 'file')),
            ),
          );
        for (const mirror of mirrors)
          await new DocumentModel(db, kb.userId).update(mirror.id, {
            ...(input.name === undefined ? {} : { title: input.name, filename: input.name }),
            ...(input.parentId === undefined ? {} : { parentId: input.parentId }),
          });
      } else {
        await new DocumentModel(db, kb.userId).update(itemId, {
          ...(input.name === undefined ? {} : { title: input.name, filename: input.name }),
          ...(input.parentId === undefined ? {} : { parentId: input.parentId }),
        });
      }
    });
    return findContent(await loadContent(this.db, kb), itemId).item;
  };

  trash = async (id: string, itemId: string) => {
    const kb = await loadEnterpriseKb(this.db, id);
    await this.db.transaction(async (tx) => {
      const db = tx as unknown as LobeChatDatabase;
      await lockEnterpriseKb(db, kb);
      findContent(await loadContent(db, kb), itemId);
      await trashEnterpriseItems(
        { serverDB: db, userId: kb.userId },
        { enterprise: true, knowledgeBaseId: id, ownerId: kb.userId, level: 'owner' },
        [itemId],
      );
    });
  };

  restore = async (id: string, itemId: string) => {
    const kb = await loadEnterpriseKb(this.db, id);
    await this.db.transaction(async (tx) => {
      const db = tx as unknown as LobeChatDatabase;
      await lockEnterpriseKb(db, kb);
      const rows = await loadContent(db, kb);
      const root = findContent(rows, itemId, true);
      breadcrumbFor(rows, root.item.parentId);
      await restoreEnterpriseTrashItem(db, { knowledgeBaseId: id, ownerId: kb.userId }, [
        root.item.id,
        ...(root.file ? [root.file.id] : []),
      ]);
    });
    return findContent(await loadContent(this.db, kb), itemId).item;
  };

  purge = async (id: string, itemId: string) => {
    const kb = await loadEnterpriseKb(this.db, id);
    const keys = await this.db.transaction(async (tx) => {
      const db = tx as unknown as LobeChatDatabase;
      await lockEnterpriseKb(db, kb);
      const rows = await loadContent(db, kb);
      const target = subtreeOf(rows, findContent(rows, itemId, true));
      const fileRows = target.flatMap((row) => (row.file ? [row.file] : []));
      const fileIds = fileRows.map((file) => file.id);
      await removeEnterpriseTrashEntries(
        db,
        { knowledgeBaseId: id, ownerId: kb.userId },
        {
          fileIds,
          documentIds: target.flatMap((row) => (row.document ? [row.document.id] : [])),
        },
      );
      // Existing model hard-delete primitives exclude trashed rows. Restore only within this transaction.
      await this.stamp(kb, target, restoreStamp(), db);
      const model = new FileModel(db, kb.userId);
      const deleted = await model.deleteMany(fileIds, serverDBEnv.REMOVE_GLOBAL_FILE);
      const documentModel = new DocumentModel(db, kb.userId);
      for (const row of target) if (row.document) await documentModel.delete(row.item.id);
      await removeEnterpriseKbItemUploaders(
        tx,
        target.map((row) => row.item.id),
      );
      await removeEnterpriseKbNodePolicies(tx, {
        knowledgeBaseId: id,
        nodeIds: target.map((row) => row.item.id),
      });
      return [...deleted.map((file) => file.url), ...(await orphanedHashlessKeys(db, fileRows))];
    });
    if (keys.length) await new FileService(this.db, kb.userId).deleteFiles(keys);
  };

  retry = async (id: string, itemId: string) => {
    const kb = await loadEnterpriseKb(this.db, id);
    const row = findContent(await loadContent(this.db, kb), itemId);
    if (!row.file || row.item.status !== 'error')
      throw invalidRequest('该条目没有可重试的失败任务。');
    await this.queue(kb.userId, row, false);
    return findContent(await loadContent(this.db, kb), itemId).item;
  };

  retryFailed = async (id: string) => {
    const kb = await loadEnterpriseKb(this.db, id);
    const failed = (await loadContent(this.db, kb)).filter(
      (row) => !row.trashed && row.file && row.item.status === 'error',
    );
    for (const row of failed) await this.queue(kb.userId, row, false);
    return { retried: failed.length };
  };

  reprocess = async (id: string) => {
    const kb = await loadEnterpriseKb(this.db, id);
    const targets = (await loadContent(this.db, kb)).filter(
      (row) => !row.trashed && row.item.kind === 'file',
    );
    let queued = 0;
    for (const row of targets) if (await this.queue(kb.userId, row, true)) queued++;
    return { queued };
  };

  download = async (id: string, itemId: string) => {
    const kb = await loadEnterpriseKb(this.db, id);
    const row = findContent(await loadContent(this.db, kb), itemId);
    if (row.document && row.item.kind === 'document') {
      const document = await new DocumentModel(this.db, kb.userId).findById(row.document.id);
      return {
        url: `data:text/markdown;charset=utf-8,${encodeURIComponent(document?.content ?? '')}`,
      };
    }
    if (!row.file) throw invalidRequest('只有文件和文稿可以下载。');
    return {
      url: await new FileService(this.db, kb.userId).createDownloadUrl(row.file.url, row.file.name),
    };
  };

  private queue = async (userId: string, row: ContentRecord, reprocess: boolean) => {
    const service = new ChunkService(this.db, userId);
    if (!reprocess && row.item.statusDetail.stage === 'embedding')
      return service.asyncEmbeddingFileChunks(row.item.id);
    // A fresh parse must not be masked by an old embedding error/success.
    await new FileModel(this.db, userId).update(row.item.id, { embeddingTaskId: null });
    return service.asyncParseFileToChunks(row.item.id);
  };

  private page = (rows: ContentRecord[], params: PageInput) => {
    const sorted = rows.toSorted(
      (a, b) =>
        Number(b.item.kind === 'folder') - Number(a.item.kind === 'folder') ||
        b.item.createdAt.localeCompare(a.item.createdAt) ||
        a.item.id.localeCompare(b.item.id),
    );
    return {
      items: sorted
        .slice((params.page - 1) * params.pageSize, params.page * params.pageSize)
        .map((row) => row.item),
      total: rows.length,
    };
  };

  private stamp = async (
    kb: { id: string; userId: string },
    target: ContentRecord[],
    stamp: ReturnType<typeof trashStamp> | ReturnType<typeof restoreStamp>,
    db = this.db,
  ) => {
    const apply = async (db: LobeChatDatabase) => {
      await lockEnterpriseKb(db, kb);
      const fileIds = target.flatMap((row) => (row.file ? [row.file.id] : []));
      const docIds = target.flatMap((row) => (row.document ? [row.item.id] : []));
      if (fileIds.length) {
        await db
          .update(files)
          .set(stamp)
          .where(
            and(inArray(files.id, fileIds), eq(files.userId, kb.userId), isNull(files.workspaceId)),
          );
        await db
          .update(documents)
          .set(stamp)
          .where(
            and(
              inArray(documents.fileId, fileIds),
              eq(documents.userId, kb.userId),
              or(eq(documents.knowledgeBaseId, kb.id), eq(documents.sourceType, 'file')),
            ),
          );
      }
      if (docIds.length)
        await db
          .update(documents)
          .set(stamp)
          .where(
            and(
              inArray(documents.id, docIds),
              eq(documents.userId, kb.userId),
              eq(documents.knowledgeBaseId, kb.id),
            ),
          );
    };
    if (db !== this.db) return apply(db);
    await db.transaction((tx) => apply(tx as unknown as LobeChatDatabase));
  };
}

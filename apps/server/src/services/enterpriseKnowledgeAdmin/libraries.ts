import type { EnterpriseKbAccessSummary, EnterpriseKbMember } from '@lobechat/business-knowledge';
import {
  findEnterpriseKbMember,
  listEnterpriseKbIds,
  markEnterpriseKb,
  recordEnterpriseKbTransfer,
  remapEnterpriseKbNodePolicies,
  summarizeEnterpriseKbAccess,
  unmarkEnterpriseKb,
} from '@lobechat/business-knowledge';
import { and, count, desc, eq, ilike, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { chunk } from 'es-toolkit/compat';

import { serverDBEnv } from '@/config/db';
import { DocumentModel } from '@/database/models/document';
import { KnowledgeBaseModel } from '@/database/models/knowledgeBase';
import {
  asyncTasks,
  chunks,
  documentChunks,
  documentHistories,
  documents,
  embeddings,
  fileChunks,
  files,
  fileUploads,
  knowledgeBaseFiles,
  type KnowledgeBaseItem,
  knowledgeBases,
  unstructuredChunks,
  users,
} from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';
import { notTrashed, restoreStamp } from '@/database/utils/softDelete';
import { removeEnterpriseTrashEntries } from '@/server/services/enterpriseKnowledge/trash';
import { FileService } from '@/server/services/file';

import { loadContent } from './contentData';
import { KbAdminError, notFound } from './errors';
import {
  type AdminActor,
  containsPattern,
  loadEnterpriseKb,
  lockEnterpriseKb,
  toEnterpriseActor,
} from './shared';
import { isProcessingStatus } from './status';
import { countKnowledgeBaseFiles } from './tasks';
import { copySharedFiles, findSharedFileIds } from './transfer';
import { transferEnterpriseTrashEntries } from './trash';

const ID_BATCH = 5000;

export interface KbOwner {
  disabled: boolean;
  email: string | null;
  id: string;
  name: string;
}

export interface KbItem {
  access: EnterpriseKbAccessSummary;
  createdAt: string;
  description: string | null;
  failedCount: number;
  fileCount: number;
  id: string;
  name: string;
  owner: KbOwner;
  processingCount: number;
  updatedAt: string;
}

const EMPTY_ACCESS: EnterpriseKbAccessSummary = {
  departmentCount: 0,
  everyone: false,
  userCount: 0,
};

const toOwner = (userId: string, member: EnterpriseKbMember | null): KbOwner =>
  member
    ? { disabled: member.disabled, email: member.email, id: member.id, name: member.name }
    : { disabled: true, email: null, id: userId, name: userId };

/**
 * Hashless files (registered without a client hash) own their storage object outright, which
 * the model's hash bookkeeping never reports for deletion: the object may go once no other
 * row names the same key.
 */
export const orphanedHashlessKeys = async (
  db: LobeChatDatabase,
  deleted: { fileHash: string | null; url: string }[],
): Promise<string[]> => {
  if (!serverDBEnv.REMOVE_GLOBAL_FILE) return [];
  const urls = [
    ...new Set(
      deleted
        .filter((file) => !file.fileHash && file.url && !file.url.startsWith('internal://'))
        .map((file) => file.url),
    ),
  ];
  if (urls.length === 0) return [];

  const stillUsed = await db.select({ url: files.url }).from(files).where(inArray(files.url, urls));
  const used = new Set(stillUsed.map((row) => row.url));

  return urls.filter((url) => !used.has(url));
};

export class EnterpriseKbLibraryService {
  constructor(private readonly db: LobeChatDatabase) {}

  list = async (params: { page: number; pageSize: number; q?: string }) => {
    const enterpriseIds = await listEnterpriseKbIds(this.db);
    if (enterpriseIds.length === 0) return { items: [], total: 0 };

    const pattern = params.q ? containsPattern(params.q) : undefined;
    const where = and(
      inArray(knowledgeBases.id, enterpriseIds),
      isNull(knowledgeBases.workspaceId),
      notTrashed(knowledgeBases.isDeleted),
      pattern
        ? or(
            ilike(knowledgeBases.name, pattern),
            ilike(users.fullName, pattern),
            ilike(users.username, pattern),
            ilike(users.email, pattern),
          )
        : undefined,
    );

    const [{ total }] = await this.db
      .select({ total: count() })
      .from(knowledgeBases)
      .innerJoin(users, eq(users.id, knowledgeBases.userId))
      .where(where);

    const rows = await this.db
      .select({ kb: knowledgeBases })
      .from(knowledgeBases)
      .innerJoin(users, eq(users.id, knowledgeBases.userId))
      .where(where)
      .orderBy(desc(knowledgeBases.updatedAt), desc(knowledgeBases.id))
      .limit(params.pageSize)
      .offset((params.page - 1) * params.pageSize);

    return { items: await this.toItems(rows.map((row) => row.kb)), total };
  };

  get = async (id: string): Promise<KbItem> => {
    const kb = await loadEnterpriseKb(this.db, id);

    return (await this.toItems([kb]))[0];
  };

  create = async (params: {
    actor: AdminActor;
    description?: string;
    name: string;
    ownerEmail: string;
  }): Promise<{ id: string }> => {
    const owner = await findEnterpriseKbMember(this.db, { email: params.ownerEmail });
    if (!owner) throw new KbAdminError('OWNER_NOT_FOUND', 'No member has this email');
    if (owner.disabled) throw new KbAdminError('OWNER_DISABLED', 'The member is disabled');

    return this.db.transaction(async (tx) => {
      const trx = tx as unknown as LobeChatDatabase;
      await this.assertNameAvailable(trx, params.name);

      const created = await new KnowledgeBaseModel(trx, owner.id).create({
        description: params.description,
        name: params.name,
      });
      await markEnterpriseKb(trx, {
        actor: toEnterpriseActor(params.actor),
        knowledgeBaseId: created.id,
        name: params.name,
      });

      return { id: created.id };
    });
  };

  update = async (
    id: string,
    params: { description?: string | null; name?: string },
  ): Promise<KbItem> => {
    const kb = await loadEnterpriseKb(this.db, id);

    await this.db.transaction(async (tx) => {
      const trx = tx as unknown as LobeChatDatabase;
      await lockEnterpriseKb(trx, kb);
      const value: Partial<KnowledgeBaseItem> = {};
      if (params.name !== undefined && params.name !== kb.name) {
        await this.assertNameAvailable(trx, params.name, id);
        value.name = params.name;
      }
      if (params.description !== undefined) value.description = params.description;
      if (Object.keys(value).length) await new KnowledgeBaseModel(trx, kb.userId).update(id, value);
    });

    return this.get(id);
  };

  remove = async (id: string, actor: AdminActor): Promise<void> => {
    const kb = await loadEnterpriseKb(this.db, id);

    const keys = await this.db.transaction(async (tx) => {
      const trx = tx as unknown as LobeChatDatabase;
      await lockEnterpriseKb(trx, kb);
      const model = new KnowledgeBaseModel(trx, kb.userId);

      // Trashed rows are invisible to the model's scoped deletes, which would leave their
      // rows and stored objects behind once the library is gone.
      const exclusiveIds = await model.findExclusiveFileIds(id);
      for (const batch of chunk(exclusiveIds, ID_BATCH)) {
        await trx.update(files).set(restoreStamp()).where(inArray(files.id, batch));
        await trx.update(documents).set(restoreStamp()).where(inArray(documents.fileId, batch));
      }
      await trx
        .update(documents)
        .set(restoreStamp())
        .where(
          and(
            eq(documents.knowledgeBaseId, id),
            eq(documents.userId, kb.userId),
            or(
              isNull(documents.fileId),
              exclusiveIds.length ? inArray(documents.fileId, exclusiveIds) : undefined,
            ),
          ),
        );

      // Folders and notes belong to the library alone but the foreign key only unlinks them.
      const leftoverDocumentIds = (
        await trx
          .select({ id: documents.id })
          .from(documents)
          .where(
            and(
              eq(documents.knowledgeBaseId, id),
              eq(documents.userId, kb.userId),
              or(
                isNull(documents.fileId),
                exclusiveIds.length ? inArray(documents.fileId, exclusiveIds) : undefined,
              ),
            ),
          )
      ).map((row) => row.id);

      const exclusiveFiles = exclusiveIds.length
        ? await trx
            .select({ fileHash: files.fileHash, url: files.url })
            .from(files)
            .where(inArray(files.id, exclusiveIds))
        : [];

      await removeEnterpriseTrashEntries(
        trx,
        { knowledgeBaseId: id, ownerId: kb.userId },
        {
          fileIds: exclusiveIds,
          documentIds: leftoverDocumentIds,
        },
      );

      const result = await model.deleteWithFiles(id, serverDBEnv.REMOVE_GLOBAL_FILE);

      const documentModel = new DocumentModel(trx, kb.userId);
      for (const documentId of leftoverDocumentIds) await documentModel.delete(documentId);

      await unmarkEnterpriseKb(trx, {
        actor: toEnterpriseActor(actor),
        knowledgeBaseId: id,
        name: kb.name,
      });

      return [
        ...result.deletedFiles.map((file) => file.url).filter((url): url is string => !!url),
        ...(await orphanedHashlessKeys(trx, exclusiveFiles)),
      ];
    });

    if (keys.length > 0) await new FileService(this.db, kb.userId).deleteFiles(keys);
  };

  transfer = async (
    id: string,
    params: { actor: AdminActor; keepPreviousOwnerEdit: boolean; toUserId: string },
  ): Promise<KbItem> => {
    const kb = await loadEnterpriseKb(this.db, id);
    if (kb.userId === params.toUserId) {
      throw new KbAdminError('TRANSFER_SAME_OWNER', 'The member already owns this knowledge base');
    }

    const receiver = await findEnterpriseKbMember(this.db, { id: params.toUserId });
    if (!receiver) throw new KbAdminError('OWNER_NOT_FOUND', 'The receiving member does not exist');
    if (receiver.disabled)
      throw new KbAdminError('OWNER_DISABLED', 'The receiving member is disabled');

    await this.db.transaction(async (tx) => {
      const trx = tx as unknown as LobeChatDatabase;
      const fromUserId = kb.userId;
      const toUserId = receiver.id;

      const [locked] = await trx
        .select({ id: knowledgeBases.id })
        .from(knowledgeBases)
        .where(and(eq(knowledgeBases.id, id), eq(knowledgeBases.userId, fromUserId)))
        .for('update');
      if (!locked) throw notFound();

      const linkedIds = (
        await trx
          .select({ id: knowledgeBaseFiles.fileId })
          .from(knowledgeBaseFiles)
          .where(eq(knowledgeBaseFiles.knowledgeBaseId, id))
      ).map((row) => row.id);

      if (linkedIds.length) {
        const fileRows = await trx
          .select({ chunk: files.chunkTaskId, embedding: files.embeddingTaskId })
          .from(files)
          .where(inArray(files.id, linkedIds))
          .for('update');
        const taskIds = [
          ...new Set(
            fileRows
              .flatMap((row) => [row.chunk, row.embedding])
              .filter((id): id is string => !!id),
          ),
        ];
        if (taskIds.length) {
          const tasks = await trx
            .select({ status: asyncTasks.status })
            .from(asyncTasks)
            .where(inArray(asyncTasks.id, taskIds))
            .for('update');
          if (tasks.some((task) => task.status === 'pending' || task.status === 'processing'))
            throw new KbAdminError('TRANSFER_BUSY', '库内还有文件在处理，处理完成后再转移');
        }
      }
      if ((await loadContent(trx, kb)).some((row) => isProcessingStatus(row.item.status))) {
        throw new KbAdminError('TRANSFER_BUSY', '库内还有文件在处理，处理完成后再转移');
      }
      const shared = await findSharedFileIds(trx, id, linkedIds);
      const movedFileIds = linkedIds.filter((fileId) => !shared.has(fileId));

      const documentIds = (
        await trx
          .select({ id: documents.id })
          .from(documents)
          .where(
            and(
              eq(documents.userId, fromUserId),
              isNull(documents.workspaceId),
              or(
                eq(documents.knowledgeBaseId, id),
                movedFileIds.length ? inArray(documents.fileId, movedFileIds) : undefined,
              ),
            ),
          )
      ).map((row) => row.id);

      const copiedResources = await copySharedFiles(trx, {
        fromUserId,
        knowledgeBaseId: id,
        shared,
        toUserId,
      });

      await reassignRows(trx, { fromUserId, knowledgeBaseId: id, movedFileIds, toUserId });
      await transferEnterpriseTrashEntries(trx, {
        copiedResources,
        documentIds: [
          ...documentIds,
          ...[...copiedResources.keys()]
            .filter((key) => key.startsWith('document:'))
            .map((key) => key.slice('document:'.length)),
        ],
        fileIds: linkedIds,
        fromUserId,
        toUserId,
      });

      if (copiedResources.size) {
        // The registry map uses kind-prefixed keys; policies use the content node's raw id.
        await remapEnterpriseKbNodePolicies(trx, {
          idMap: Object.fromEntries(
            [...copiedResources].map(([resource, copiedId]) => [
              resource.slice(resource.indexOf(':') + 1),
              copiedId,
            ]),
          ),
          knowledgeBaseId: id,
        });
      }

      await recordEnterpriseKbTransfer(trx, {
        actor: toEnterpriseActor(params.actor),
        fileCount: linkedIds.length,
        fromUserId,
        keepPreviousOwnerEdit: params.keepPreviousOwnerEdit,
        knowledgeBaseId: id,
        toUserId,
      });
    });

    return this.get(id);
  };

  private assertNameAvailable = async (db: LobeChatDatabase, name: string, excludeId?: string) => {
    // Same pattern as AgentShareModel: serialize this tenant/name until the write commits.
    await db.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(current_schema()), hashtext(${`enterprise-kb-name:${name}`}))`,
    );
    const enterpriseIds = await listEnterpriseKbIds(db);
    if (enterpriseIds.length === 0) return;

    const [existing] = await db
      .select({ id: knowledgeBases.id })
      .from(knowledgeBases)
      .where(
        and(
          inArray(knowledgeBases.id, enterpriseIds),
          eq(knowledgeBases.name, name),
          isNull(knowledgeBases.workspaceId),
          notTrashed(knowledgeBases.isDeleted),
          excludeId ? ne(knowledgeBases.id, excludeId) : undefined,
        ),
      )
      .limit(1);
    if (existing) {
      throw new KbAdminError('NAME_EXISTS', 'An enterprise knowledge base has this name already');
    }
  };

  private toItems = async (rows: KnowledgeBaseItem[]): Promise<KbItem[]> => {
    const ids = rows.map((row) => row.id);
    const ownerIds = [...new Set(rows.map((row) => row.userId))];

    const [counts, access, members] = await Promise.all([
      countKnowledgeBaseFiles(this.db, ids),
      summarizeEnterpriseKbAccess(this.db, ids),
      Promise.all(ownerIds.map((ownerId) => findEnterpriseKbMember(this.db, { id: ownerId }))),
    ]);
    const owners = new Map(
      ownerIds.map((ownerId, index) => [ownerId, toOwner(ownerId, members[index])]),
    );

    return rows.map((row) => ({
      access: access[row.id] ?? EMPTY_ACCESS,
      createdAt: row.createdAt.toISOString(),
      description: row.description,
      failedCount: counts[row.id].failedCount,
      fileCount: counts[row.id].fileCount,
      id: row.id,
      name: row.name,
      owner: owners.get(row.userId)!,
      processingCount: counts[row.id].processingCount,
      updatedAt: row.updatedAt.toISOString(),
    }));
  };
}

/** Moves the library and everything inside it from one user to another. */
const reassignRows = async (
  db: LobeChatDatabase,
  params: {
    fromUserId: string;
    knowledgeBaseId: string;
    movedFileIds: string[];
    toUserId: string;
  },
) => {
  const { fromUserId, knowledgeBaseId, movedFileIds, toUserId } = params;
  const to = { userId: toUserId };

  await db
    .update(knowledgeBases)
    .set({ ...to, updatedAt: new Date() })
    .where(and(eq(knowledgeBases.id, knowledgeBaseId), eq(knowledgeBases.userId, fromUserId)));
  await db
    .update(knowledgeBaseFiles)
    .set(to)
    .where(
      and(
        eq(knowledgeBaseFiles.knowledgeBaseId, knowledgeBaseId),
        eq(knowledgeBaseFiles.userId, fromUserId),
      ),
    );

  for (const batch of chunk(movedFileIds, ID_BATCH)) {
    const tasks = await db
      .select({ chunk: files.chunkTaskId, embedding: files.embeddingTaskId })
      .from(files)
      .where(inArray(files.id, batch));
    const taskIds = tasks
      .flatMap((row) => [row.chunk, row.embedding])
      .filter((taskId): taskId is string => !!taskId);

    const chunkIds = db
      .select({ id: fileChunks.chunkId })
      .from(fileChunks)
      .where(inArray(fileChunks.fileId, batch));

    await db
      .update(embeddings)
      .set(to)
      .where(and(inArray(embeddings.chunkId, chunkIds), eq(embeddings.userId, fromUserId)));
    await db
      .update(chunks)
      .set(to)
      .where(and(inArray(chunks.id, chunkIds), eq(chunks.userId, fromUserId)));
    await db
      .update(unstructuredChunks)
      .set(to)
      .where(
        and(inArray(unstructuredChunks.fileId, batch), eq(unstructuredChunks.userId, fromUserId)),
      );
    await db
      .update(fileChunks)
      .set(to)
      .where(and(inArray(fileChunks.fileId, batch), eq(fileChunks.userId, fromUserId)));
    if (taskIds.length > 0) {
      await db
        .update(asyncTasks)
        .set(to)
        .where(and(inArray(asyncTasks.id, taskIds), eq(asyncTasks.userId, fromUserId)));
    }
    await db
      .update(fileUploads)
      .set(to)
      .where(and(inArray(fileUploads.fileId, batch), eq(fileUploads.userId, fromUserId)));
    await db
      .update(files)
      .set(to)
      .where(and(inArray(files.id, batch), eq(files.userId, fromUserId)));
  }

  const documentIds = (
    await db
      .select({ id: documents.id })
      .from(documents)
      .where(
        and(
          eq(documents.userId, fromUserId),
          movedFileIds.length > 0
            ? or(
                eq(documents.knowledgeBaseId, knowledgeBaseId),
                inArray(documents.fileId, movedFileIds),
              )
            : eq(documents.knowledgeBaseId, knowledgeBaseId),
        ),
      )
  ).map((row) => row.id);

  for (const batch of chunk(documentIds, ID_BATCH)) {
    const chunkIds = db
      .select({ id: documentChunks.chunkId })
      .from(documentChunks)
      .where(inArray(documentChunks.documentId, batch));

    await db
      .update(embeddings)
      .set(to)
      .where(and(inArray(embeddings.chunkId, chunkIds), eq(embeddings.userId, fromUserId)));
    await db
      .update(chunks)
      .set(to)
      .where(and(inArray(chunks.id, chunkIds), eq(chunks.userId, fromUserId)));
    await db
      .update(documentChunks)
      .set(to)
      .where(and(inArray(documentChunks.documentId, batch), eq(documentChunks.userId, fromUserId)));
    await db
      .update(documentHistories)
      .set(to)
      .where(
        and(inArray(documentHistories.documentId, batch), eq(documentHistories.userId, fromUserId)),
      );
    await db
      .update(documents)
      .set(to)
      .where(and(inArray(documents.id, batch), eq(documents.userId, fromUserId)));
  }
};

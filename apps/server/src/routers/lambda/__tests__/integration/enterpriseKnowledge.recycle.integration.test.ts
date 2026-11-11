import type * as BusinessKnowledge from '@lobechat/business-knowledge';
// @vitest-environment node
import type { LobeChatDatabase } from '@lobechat/database';
import {
  documents,
  files,
  knowledgeBaseFiles,
  trashItems,
  users,
  workspaces,
} from '@lobechat/database/schemas';
import { getTestDB } from '@lobechat/database/test-utils';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { DocumentModel } from '@/database/models/document';
import { restoreStamp } from '@/database/utils/softDelete';
import { createEnterpriseDocuments } from '@/server/services/enterpriseKnowledge/createDocuments';
import { trashEnterpriseItems } from '@/server/services/enterpriseKnowledge/trash';
import { EnterpriseKbContentService } from '@/server/services/enterpriseKnowledgeAdmin/content';
import { EnterpriseKbLibraryService } from '@/server/services/enterpriseKnowledgeAdmin/libraries';
import { TrashService } from '@/server/services/trash';
import { resetEnterpriseKbState } from '@/server/test-utils/enterpriseKnowledgeFake';

import { documentRouter } from '../../document';
import { fileRouter } from '../../file';
import { trashRouter } from '../../trash';
import {
  context,
  createKbFile,
  type EnterpriseWorld,
  seedEnterpriseWorld,
} from './enterpriseKnowledge.fixture';

const seams = vi.hoisted(() => ({ transfer: vi.fn(), unmark: vi.fn() }));
vi.mock('@lobechat/business-knowledge', async (original) => {
  const { fakeBusinessKnowledge, enterpriseKbState } =
    await import('@/server/test-utils/enterpriseKnowledgeFake');
  return {
    ...(await original<typeof BusinessKnowledge>()),
    ...fakeBusinessKnowledge,
    getEnterpriseKbItemUploaders: async () => ({}),
    listEnterpriseKbNodePolicies: async () => [],
    removeEnterpriseKbItemUploaders: async () => {},
    removeEnterpriseKbNodePolicies: async () => {},
    remapEnterpriseKbNodePolicies: async () => {},
    summarizeEnterpriseKbAccess: async () => ({}),
    findEnterpriseKbMember: async (_db: unknown, p: { id: string }) => ({
      id: p.id,
      name: p.id,
      disabled: false,
      email: null,
    }),
    recordEnterpriseKbTransfer: async (
      db: unknown,
      p: { knowledgeBaseId: string; toUserId: string; keepPreviousOwnerEdit: boolean },
    ) => {
      await seams.transfer(db, p);
      const kb = enterpriseKbState.kbs.get(p.knowledgeBaseId)!;
      const from = kb.ownerId;
      kb.ownerId = p.toUserId;
      kb.grants = p.keepPreviousOwnerEdit ? { [from]: 'edit' } : {};
    },
    unmarkEnterpriseKb: seams.unmark,
  };
});
vi.mock('@/server/services/file', () => ({
  FileService: class {
    deleteFiles = vi.fn();
    getFileAccessUrl = async ({ id }: { id: string }) => `/f/${id}`;
  },
}));
let db: LobeChatDatabase;
vi.mock('@/database/core/db-adaptor', () => ({ getServerDB: () => db }));

const actor = { id: 'admin', name: 'Admin' };
let w: EnterpriseWorld;
let content: EnterpriseKbContentService;
const front = (userId = w.owner) => trashRouter.createCaller(context(userId) as never);
const trash = (ids: string[], userId = w.owner) =>
  trashEnterpriseItems(
    { serverDB: db, userId },
    { enterprise: true, knowledgeBaseId: w.entA, ownerId: w.owner, level: 'owner' },
    ids,
  );
const entries = () => db.select().from(trashItems).where(eq(trashItems.userId, w.owner));
const entryFor = async (id: string) =>
  (await db.select().from(trashItems).where(eq(trashItems.resourceId, id)))[0];
const file = async (id: string) => (await db.select().from(files).where(eq(files.id, id)))[0];
const document = async (id: string) =>
  (await db.select().from(documents).where(eq(documents.id, id)))[0];
// Match parseFile's persisted shape: the KB comes from the backing file, not necessarily the doc.
const parsedDocument = (knowledgeBaseId?: string) =>
  new DocumentModel(db, w.owner).create({
    content: 'parsed file body',
    fileId: w.entAFile,
    fileType: 'custom/document',
    filename: 'a.txt',
    knowledgeBaseId,
    source: 'files/a.txt',
    sourceType: 'file',
    title: 'a.txt',
    totalCharCount: 16,
    totalLineCount: 1,
  });
const frontendDocuments = () => documentRouter.createCaller(context(w.owner) as never);
const frontendItems = () =>
  fileRouter.createCaller(context(w.owner) as never).getKnowledgeItems({ knowledgeBaseId: w.entA });
const visible = async (userId = w.owner) =>
  (await front(userId).list()).items.map((row) => row.resourceId);
const transfer = (keepPreviousOwnerEdit = false) =>
  new EnterpriseKbLibraryService(db).transfer(w.entA, {
    actor,
    keepPreviousOwnerEdit,
    toUserId: w.viewer,
  });

beforeAll(async () => {
  db = await getTestDB();
});
beforeEach(async () => {
  resetEnterpriseKbState();
  seams.transfer.mockReset();
  seams.unmark.mockReset();
  w = await seedEnterpriseWorld(db);
  content = new EnterpriseKbContentService(db);
});
afterEach(async () => {
  await db.delete(users).where(inArray(users.id, [w.owner, w.viewer, w.editor, w.stranger]));
});

describe('enterprise recycle lifecycle across frontend and governance', () => {
  it.each([false, true])(
    'restores the original parsed identity by physical file id (explicit KB: %s)',
    async (explicitKb) => {
      const doc = await parsedDocument(explicitKb ? w.entA : undefined);
      expect(doc.knowledgeBaseId).toBe(explicitKb ? w.entA : null);
      expect((await frontendItems()).items).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: doc.id, fileId: w.entAFile })]),
      );
      await frontendDocuments().deleteDocument({ id: w.entADoc });
      await content.trash(w.entB, w.entBFile);
      const independent = await entryFor(w.entADoc);
      const foreign = await entryFor(w.entBFile);
      await frontendDocuments().deleteDocument({ id: doc.id });
      const root = await entryFor(doc.id);
      expect(root).toMatchObject({ resourceType: 'document', rootId: null });
      expect(await entryFor(w.entAFile)).toMatchObject({ rootId: root.id });
      expect(await visible()).toContain(doc.id);
      expect((await content.listTrash(w.entA, { page: 1, pageSize: 50 })).items).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: w.entAFile })]),
      );
      await expect(content.restore(w.entB, w.entAFile)).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
      await expect(content.restore(w.entA, w.entAFile)).resolves.toMatchObject({ id: w.entAFile });
      expect(await document(doc.id)).toMatchObject({
        id: doc.id,
        content: 'parsed file body',
        isDeleted: null,
      });
      expect(await file(w.entAFile)).toMatchObject({ isDeleted: null });
      expect(await entryFor(doc.id)).toBeUndefined();
      expect(await entryFor(w.entAFile)).toBeUndefined();
      expect(await entryFor(w.entADoc)).toEqual(independent);
      expect(await entryFor(w.entBFile)).toEqual(foreign);
      expect((await frontendItems()).items.filter((item) => item.fileId === w.entAFile)).toEqual([
        expect.objectContaining({ id: doc.id, sourceType: 'file' }),
      ]);
      expect((await frontendDocuments().getDocumentById({ id: doc.id }))?.content).toBe(
        'parsed file body',
      );
      await expect(content.restore(w.entA, w.entAFile)).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
      await TrashService.sweepExpired(db, { now: new Date(root.expiresAt.getTime() + 1) });
      expect(await document(doc.id)).toMatchObject({ isDeleted: null });
      expect(await file(w.entAFile)).toMatchObject({ isDeleted: null });
    },
  );

  it('rolls back parsed content and the whole registry graph when restore cleanup fails', async () => {
    const doc = await parsedDocument();
    await frontendDocuments().deleteDocument({ id: doc.id });
    const before = await entries();
    await db.execute(sql`CREATE FUNCTION fail_restore_cleanup() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'restore cleanup failed'; END; $$ LANGUAGE plpgsql`);
    await db.execute(sql`CREATE TRIGGER fail_restore_cleanup BEFORE DELETE ON trash_items
      FOR EACH ROW EXECUTE FUNCTION fail_restore_cleanup()`);
    try {
      await expect(content.restore(w.entA, w.entAFile)).rejects.toThrow();
      expect(await document(doc.id)).toMatchObject({ isDeleted: true });
      expect(await file(w.entAFile)).toMatchObject({ isDeleted: true });
      expect(await entries()).toEqual(before);
    } finally {
      await db.execute(sql`DROP TRIGGER fail_restore_cleanup ON trash_items`);
      await db.execute(sql`DROP FUNCTION fail_restore_cleanup()`);
    }
    await content.restore(w.entA, w.entAFile);
    expect(await document(doc.id)).toMatchObject({ isDeleted: null });
    expect(await entries()).toEqual([]);
  });

  it.each(['library', 'owner', 'workspace'] as const)(
    'rejects a parsed deletion graph containing a different %s scope atomically',
    async (scope) => {
      const doc = await parsedDocument();
      await frontendDocuments().deleteDocument({ id: doc.id });
      const root = await entryFor(doc.id);
      if (scope === 'library') {
        await content.trash(w.entB, w.entBFile);
        await db
          .update(trashItems)
          .set({ rootId: root.id })
          .where(eq(trashItems.resourceId, w.entBFile));
      } else {
        await frontendDocuments().deleteDocument({ id: w.entADoc });
        const other = await entryFor(w.entADoc);
        if (scope === 'owner') {
          await db
            .update(trashItems)
            .set({ rootId: root.id, userId: w.stranger })
            .where(eq(trashItems.id, other.id));
        } else {
          const [workspace] = await db
            .insert(workspaces)
            .values({
              name: 'Other scope',
              slug: w.owner,
              primaryOwnerId: w.owner,
            })
            .returning();
          await db
            .update(trashItems)
            .set({ rootId: root.id, workspaceId: workspace.id })
            .where(eq(trashItems.id, other.id));
        }
      }
      const before = await db.select().from(trashItems);
      await expect(content.restore(w.entA, w.entAFile)).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
      expect(await document(doc.id)).toMatchObject({ isDeleted: true });
      expect(await file(w.entAFile)).toMatchObject({ isDeleted: true });
      expect(await db.select().from(trashItems)).toEqual(before);
    },
  );

  it.each([false, true])(
    'restores a transferred parsed deletion graph by physical id (shared copy: %s)',
    async (shared) => {
      const doc = await parsedDocument();
      if (shared)
        await db.insert(knowledgeBaseFiles).values({
          fileId: w.entAFile,
          knowledgeBaseId: w.personalKb,
          userId: w.owner,
        });
      await frontendDocuments().deleteDocument({ id: doc.id });
      await transfer();
      const [link] = await db
        .select()
        .from(knowledgeBaseFiles)
        .where(eq(knowledgeBaseFiles.knowledgeBaseId, w.entA));
      const [movedDoc] = await db.select().from(documents).where(eq(documents.fileId, link.fileId));
      expect(link.fileId === w.entAFile).toBe(!shared);
      expect(movedDoc.id === doc.id).toBe(!shared);
      expect(await entryFor(movedDoc.id)).toMatchObject({ userId: w.viewer, rootId: null });
      await content.restore(w.entA, link.fileId);
      expect(await document(movedDoc.id)).toMatchObject({
        isDeleted: null,
        userId: w.viewer,
        content: 'parsed file body',
      });
      expect(await file(link.fileId)).toMatchObject({ isDeleted: null, userId: w.viewer });
      expect(await entryFor(movedDoc.id)).toBeUndefined();
      expect(await entryFor(link.fileId)).toBeUndefined();
      if (shared) {
        expect(await document(doc.id)).toMatchObject({ isDeleted: true, userId: w.owner });
        expect(await file(w.entAFile)).toMatchObject({ isDeleted: true, userId: w.owner });
        const original = await entryFor(doc.id);
        expect(original).toMatchObject({ userId: w.owner, rootId: null });
        expect(await new TrashService(db, w.owner).restore([original.id])).toMatchObject({
          failed: [],
        });
        expect(await document(doc.id)).toMatchObject({ isDeleted: null });
      }
    },
  );

  it('purges a parsed file and its registry without touching a foreign library', async () => {
    const doc = await parsedDocument();
    await frontendDocuments().deleteDocument({ id: doc.id });
    await content.trash(w.entB, w.entBFile);
    const foreign = await entryFor(w.entBFile);
    await content.purge(w.entA, w.entAFile);
    expect(await document(doc.id)).toBeUndefined();
    expect(await file(w.entAFile)).toBeUndefined();
    expect(await entryFor(doc.id)).toBeUndefined();
    expect(await entryFor(w.entAFile)).toBeUndefined();
    expect(await entryFor(w.entBFile)).toEqual(foreign);
    expect(await file(w.entBFile)).toMatchObject({ isDeleted: true });
  });

  it.each(['frontend', 'governance'] as const)(
    'restores native documents and their mirror files through %s',
    async (via) => {
      const [doc] = await createEnterpriseDocuments(
        { serverDB: db, userId: w.owner },
        { enterprise: true, knowledgeBaseId: w.entA, ownerId: w.owner, level: 'owner' },
        [{ title: 'Native page', content: 'page body', parentId: w.entAFolder }],
      );
      await content.trash(w.entA, doc.id);
      expect(await entryFor(doc.id)).toBeDefined();
      expect(await entryFor(doc.fileId!)).toBeDefined();
      if (via === 'frontend') {
        const row = await entryFor(doc.id);
        expect(await front().restore({ ids: [row.id] })).toMatchObject({ failed: [] });
      } else {
        await content.restore(w.entA, doc.id);
      }
      expect((await file(doc.fileId!)).isDeleted).not.toBe(true);
      expect(await entryFor(doc.id)).toBeUndefined();
      expect(await entryFor(doc.fileId!)).toBeUndefined();
    },
  );

  it('uses registry cascade membership, preserving independent trash even when timestamps coincide', async () => {
    await trash([w.entADoc]);
    await content.trash(w.entA, w.entAFolder);
    const root = await entryFor(w.entAFolder);
    await db
      .update(documents)
      .set({ deletedAt: root.deletedAt })
      .where(eq(documents.id, w.entADoc));
    await content.restore(w.entA, w.entAFolder);
    expect(
      (await db.select().from(documents).where(eq(documents.id, w.entADoc)))[0].isDeleted,
    ).toBe(true);
    expect(await entryFor(w.entADoc)).toBeDefined();
  });

  it('registers governance deletion for the owner and restores it through the frontend', async () => {
    await content.trash(w.entA, w.entAFile);
    expect(await visible()).toContain(w.entAFile);
    expect(await front().countByType()).toMatchObject({ file: 1 });
    const row = await entryFor(w.entAFile);
    for (const userId of [w.editor, w.viewer]) {
      await expect(front(userId).restore({ ids: [row.id] })).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      await expect(front(userId).purge({ ids: [row.id] })).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
    }
    expect(await front().restore({ ids: [row.id] })).toMatchObject({
      failed: [],
      restored: [{ resourceId: w.entAFile }],
    });
    expect((await file(w.entAFile)).isDeleted).not.toBe(true);
    expect(await entryFor(w.entAFile)).toBeUndefined();
  });

  it('restores a governance folder cascade in frontend while preserving independently deleted children', async () => {
    const child = await createKbFile(db, {
      knowledgeBaseId: w.entA,
      name: 'child',
      userId: w.owner,
      parentId: w.entAFolder,
    });
    await trash([w.entADoc]);
    const older = await entryFor(w.entADoc);
    await content.trash(w.entA, w.entAFolder);
    const root = await entryFor(w.entAFolder);
    expect(await entryFor(child)).toMatchObject({ rootId: root.id });
    expect(await front().restore({ ids: [root.id] })).toMatchObject({ failed: [] });
    expect((await file(child)).isDeleted).not.toBe(true);
    expect(await entryFor(w.entADoc)).toMatchObject({ id: older.id, rootId: null });
    expect(await visible()).toEqual([w.entADoc]);
  });

  it('clears frontend registry when governance restores, so expiry leaves the live file intact', async () => {
    await trash([w.entAFile]);
    const row = await entryFor(w.entAFile);
    await content.restore(w.entA, w.entAFile);
    expect(await visible()).not.toContain(w.entAFile);
    // The original expiry must have no remaining target, even if the job ran much later.
    expect(
      await TrashService.sweepExpired(db, { now: new Date(row.expiresAt.getTime() + 1) }),
    ).toMatchObject({ failed: 0 });
    expect(await file(w.entAFile)).toMatchObject({ id: w.entAFile, isDeleted: null });
  });

  it('never physically deletes live content referenced by a stale expired registry', async () => {
    await trash([w.entAFile]);
    await db.update(files).set(restoreStamp()).where(eq(files.id, w.entAFile));
    await db
      .update(trashItems)
      .set({ expiresAt: new Date(0) })
      .where(eq(trashItems.resourceId, w.entAFile));
    await TrashService.sweepExpired(db);
    expect(await file(w.entAFile)).toMatchObject({ id: w.entAFile, isDeleted: null });
  });

  it('clears only this subtree registry when governance purges, including older independent trash', async () => {
    await db.update(files).set({ parentId: w.entAFolder }).where(eq(files.id, w.entAFile));
    await trash([w.entAFile]);
    await trash([w.entAFolder]);
    await trashEnterpriseItems(
      { serverDB: db, userId: w.owner },
      { enterprise: true, knowledgeBaseId: w.entB, ownerId: w.owner, level: 'owner' },
      [w.entBFile],
    );
    const other = await entryFor(w.entBFile);
    await content.purge(w.entA, w.entAFolder);
    expect(await file(w.entAFile)).toBeUndefined();
    expect(await entryFor(w.entAFile)).toBeUndefined();
    expect(await entryFor(w.entAFolder)).toBeUndefined();
    expect(await entryFor(w.entADoc)).toBeUndefined();
    expect(await entryFor(w.entBFile)).toMatchObject({ id: other.id });
  });

  it.each([true, false])(
    'transfers the whole registry cascade and gives recycle control only to the new owner (keep edit: %s)',
    async (keepEdit) => {
      await db.update(files).set({ parentId: w.entAFolder }).where(eq(files.id, w.entAFile));
      await trash([w.entAFolder]);
      const root = await entryFor(w.entAFolder);
      await transfer(keepEdit);
      expect(await visible(w.owner)).not.toContain(w.entAFolder);
      expect(await visible(w.viewer)).toContain(w.entAFolder);
      for (const id of [w.entAFolder, w.entADoc, w.entAFile]) {
        expect(await entryFor(id)).toMatchObject({ userId: w.viewer });
      }
      await expect(front(w.owner).restore({ ids: [root.id] })).rejects.toMatchObject({
        code: keepEdit ? 'FORBIDDEN' : 'NOT_FOUND',
      });
      if (keepEdit) {
        expect(await front(w.viewer).restore({ ids: [root.id] })).toMatchObject({
          failed: [],
          restored: [{ resourceId: w.entAFolder }],
        });
        expect((await file(w.entAFile)).isDeleted).not.toBe(true);
      } else {
        expect(await front(w.viewer).purge({ ids: [root.id] })).toEqual({ purged: 1 });
        expect(await file(w.entAFile)).toBeUndefined();
        expect(await entryFor(w.entAFile)).toBeUndefined();
      }
    },
  );

  it('returns a recoverable parentTrashed result, then restores the parent and independent child together', async () => {
    await trash([w.entADoc]);
    await trash([w.entAFolder]);
    const child = await entryFor(w.entADoc);
    const parent = await entryFor(w.entAFolder);
    expect(await front().restore({ ids: [child.id] })).toMatchObject({
      restored: [],
      failed: [{ code: 'parentTrashed' }],
    });
    expect(await front().restore({ ids: [child.id, parent.id] })).toMatchObject({
      failed: [],
      restored: expect.any(Array),
    });
    expect(await visible()).toEqual([]);
    expect(
      (await db.select().from(documents).where(eq(documents.id, w.entADoc)))[0].isDeleted,
    ).not.toBe(true);
  });

  it('rolls back registry ownership and content if transfer accounting fails', async () => {
    await trash([w.entAFile]);
    const row = await entryFor(w.entAFile);
    seams.transfer.mockRejectedValueOnce(new Error('transfer accounting failed'));
    await expect(transfer()).rejects.toThrow('transfer accounting failed');
    expect(await entryFor(w.entAFile)).toMatchObject({ id: row.id, userId: w.owner });
    expect(await file(w.entAFile)).toMatchObject({ userId: w.owner, isDeleted: true });
    expect(await visible()).toContain(w.entAFile);
  });

  it('remaps copied shared files and mirrors into the transferred cascade, retaining the other library recycle entry', async () => {
    await db.update(files).set({ parentId: w.entAFolder }).where(eq(files.id, w.entAFile));
    await db
      .insert(knowledgeBaseFiles)
      .values({ fileId: w.entAFile, knowledgeBaseId: w.personalKb, userId: w.owner });
    const [mirror] = await db
      .insert(documents)
      .values({
        fileId: w.entAFile,
        knowledgeBaseId: w.entA,
        userId: w.owner,
        sourceType: 'file',
        source: '',
        fileType: 'text/plain',
        title: 'Parsed shared file',
        content: 'shared',
        totalCharCount: 6,
        totalLineCount: 1,
        parentId: w.entAFolder,
      })
      .returning();
    await trash([w.entAFolder]);
    const root = await entryFor(w.entAFolder);
    await transfer();
    const links = await db
      .select()
      .from(knowledgeBaseFiles)
      .where(eq(knowledgeBaseFiles.knowledgeBaseId, w.entA));
    const copiedFile = links[0].fileId;
    expect(copiedFile).not.toBe(w.entAFile);
    const [copiedDoc] = await db.select().from(documents).where(eq(documents.fileId, copiedFile));
    expect(await entryFor(copiedFile)).toMatchObject({ userId: w.viewer, rootId: root.id });
    expect(await entryFor(copiedDoc.id)).toMatchObject({ userId: w.viewer, rootId: root.id });
    expect(await entryFor(w.entAFile)).toMatchObject({ userId: w.owner, rootId: null });
    expect(await visible(w.owner)).not.toContain(w.entAFolder);
    expect(await front(w.viewer).restore({ ids: [root.id] })).toMatchObject({ failed: [] });
    expect((await file(copiedFile)).isDeleted).not.toBe(true);
    expect((await file(w.entAFile)).isDeleted).toBe(true);
    const original = await entryFor(w.entAFile);
    expect(await new TrashService(db, w.owner).restore([original.id])).toMatchObject({
      failed: [],
    });
    expect((await file(w.entAFile)).isDeleted).not.toBe(true);
    expect(
      (await db.select().from(documents).where(eq(documents.id, mirror.id)))[0].isDeleted,
    ).not.toBe(true);
  });

  it('removes library registry atomically without removing another library registry', async () => {
    await trash([w.entAFolder, w.entAFile]);
    await trashEnterpriseItems(
      { serverDB: db, userId: w.owner },
      { enterprise: true, knowledgeBaseId: w.entB, ownerId: w.owner, level: 'owner' },
      [w.entBFile],
    );
    const before = await entries();
    seams.unmark.mockRejectedValueOnce(new Error('unmark failed'));
    await expect(new EnterpriseKbLibraryService(db).remove(w.entA, actor)).rejects.toThrow(
      'unmark failed',
    );
    expect(await entries()).toEqual(before);
    await new EnterpriseKbLibraryService(db).remove(w.entA, actor);
    expect((await entries()).map((row) => row.resourceId)).toEqual([w.entBFile]);
    expect(await file(w.entBFile)).toMatchObject({ isDeleted: true });
  });

  it('rejects a foreign library item without modifying its file or registry', async () => {
    await expect(content.trash(w.entA, w.entBFile)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await file(w.entBFile)).isDeleted).not.toBe(true);
    expect(await entryFor(w.entBFile)).toBeUndefined();
  });

  it('rolls back an entire governance deletion when a folder descendant belongs to another library', async () => {
    await db.update(files).set({ parentId: w.entAFolder }).where(eq(files.id, w.entBFile));
    await expect(content.trash(w.entA, w.entAFolder)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(
      (await db.select().from(documents).where(eq(documents.id, w.entAFolder)))[0].isDeleted,
    ).not.toBe(true);
    expect((await file(w.entBFile)).isDeleted).not.toBe(true);
    expect(await entries()).toEqual([]);
  });
});

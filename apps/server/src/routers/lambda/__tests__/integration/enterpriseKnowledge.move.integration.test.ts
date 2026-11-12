// @vitest-environment node
import type * as BusinessKnowledge from '@lobechat/business-knowledge';
import type { LobeChatDatabase } from '@lobechat/database';
import {
  asyncTasks,
  chunks,
  documentChunks,
  documents,
  embeddings,
  fileChunks,
  files,
  globalFiles,
  knowledgeBaseFiles,
  knowledgeBases,
  trashItems,
  workspaces,
} from '@lobechat/database/schemas';
import { getTestDB } from '@lobechat/database/test-utils';
import { eq, inArray } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { DocumentService } from '@/server/services/document';
import { enterpriseContentTrashHandler } from '@/server/services/enterpriseKnowledge/trash';
import {
  enterpriseKbState,
  resetEnterpriseKbState,
} from '@/server/test-utils/enterpriseKnowledgeFake';

import { enterpriseKnowledgeRouter } from '../../enterpriseKnowledge';
import {
  context,
  createChunk,
  createDoc,
  createKbFile,
  type EnterpriseWorld,
  seedEnterpriseWorld,
} from './enterpriseKnowledge.fixture';

const policy = vi.hoisted(() => ({
  nodes: new Map<string, 'edit' | 'view' | null>(),
  record: vi.fn(),
}));
vi.mock('@lobechat/business-knowledge', async (original) => {
  const real = await original<typeof BusinessKnowledge>();
  const { fakeBusinessKnowledge: fake, enterpriseKbState: state } =
    await import('@/server/test-utils/enterpriseKnowledgeFake');
  return {
    ...real,
    ...fake,
    recordEnterpriseKbContentMove: policy.record,
    resolveEnterpriseKbAccess: async (db: unknown, userId: string, id: string) => {
      const r = await fake.resolveEnterpriseKbAccess(db, userId, id);
      if (!r.enterprise) return r;
      return {
        enterprise: true,
        access: r.access ? { ...r.access, hasNodePolicies: policy.nodes.size > 0 } : null,
      };
    },
    resolveEnterpriseKbUserTree: async (_db: unknown, userId: string, id: string) => {
      const kb = state.kbs.get(id)!;
      return {
        knowledgeBaseId: id,
        ownerId: kb.ownerId,
        owner: kb.ownerId === userId,
        libraryLevel: kb.grants[userId] ?? null,
        nodes: [...policy.nodes].map(([nodeId, level]) => ({ nodeId, level })),
      };
    },
  };
});
let db: LobeChatDatabase;
vi.mock('@/database/core/db-adaptor', () => ({ getServerDB: () => db }));

describe('controlled enterprise content move with real relational transactions', () => {
  let w: EnterpriseWorld;
  const caller = (id = w.editor) => enterpriseKnowledgeRouter.createCaller(context(id) as never);
  beforeAll(async () => {
    db = await getTestDB();
  });
  beforeEach(async () => {
    resetEnterpriseKbState();
    policy.nodes.clear();
    policy.record.mockReset();
    w = await seedEnterpriseWorld(db);
  });
  const input = (ids: string[], parentId?: string | null) => ({
    knowledgeBaseId: w.entA,
    ids,
    parentId,
  });
  const row = async (id: string) => (await db.select().from(files).where(eq(files.id, id)))[0];

  it('moves an editor personal file by copying bytes/indexes to the owner and deleting its original', async () => {
    const fileId = await createKbFile(db, { userId: w.editor, name: 'member.txt' });
    const hash = `hash-${fileId}`;
    await db.insert(globalFiles).values({
      hashId: hash,
      creator: w.editor,
      fileType: 'text/plain',
      size: 10,
      url: 'files/member.txt',
    });
    await db.update(files).set({ fileHash: hash }).where(eq(files.id, fileId));
    const chunkId = await createChunk(db, w.editor, fileId, 'member indexed content');
    await db.insert(embeddings).values({
      chunkId,
      userId: w.editor,
      model: 'test',
      embeddings: Array.from({ length: 1024 }).fill(0.1),
    });
    const mirror = await createDoc(db, {
      userId: w.editor,
      title: 'mirror',
      content: 'full parsed content',
    });
    await db.update(documents).set({ fileId, sourceType: 'file' }).where(eq(documents.id, mirror));
    await db
      .insert(documentChunks)
      .values({ documentId: mirror, chunkId, userId: w.editor, pageIndex: 3 });
    const result = await caller().moveIn(input([fileId], w.entAFolder));
    const target = result.items[0].targetId;
    expect(target).not.toBe(fileId);
    expect(await row(fileId)).toBeUndefined();
    expect(await row(target)).toMatchObject({
      userId: w.owner,
      workspaceId: null,
      parentId: w.entAFolder,
      fileHash: hash,
      url: 'files/member.txt',
    });
    expect(await db.select().from(globalFiles).where(eq(globalFiles.hashId, hash))).toHaveLength(1);
    expect(
      await db.select().from(knowledgeBaseFiles).where(eq(knowledgeBaseFiles.fileId, target)),
    ).toMatchObject([{ knowledgeBaseId: w.entA, userId: w.owner }]);
    const [link] = await db.select().from(fileChunks).where(eq(fileChunks.fileId, target));
    expect(link.chunkId).not.toBe(chunkId);
    expect(await db.select().from(chunks).where(eq(chunks.id, link.chunkId!))).toMatchObject([
      { userId: w.owner, text: 'member indexed content' },
    ]);
    expect(
      await db.select().from(embeddings).where(eq(embeddings.chunkId, link.chunkId!)),
    ).toMatchObject([{ userId: w.owner, model: 'test', embeddings: expect.any(Array) }]);
    const [copiedMirror] = await db.select().from(documents).where(eq(documents.fileId, target));
    expect(copiedMirror).toMatchObject({
      userId: w.owner,
      knowledgeBaseId: w.entA,
      parentId: w.entAFolder,
      content: 'full parsed content',
    });
    expect(
      await db.select().from(documentChunks).where(eq(documentChunks.documentId, copiedMirror.id)),
    ).toMatchObject([{ chunkId: link.chunkId, userId: w.owner, pageIndex: 3 }]);
    expect(enterpriseKbState.uploaders).toContainEqual(
      expect.objectContaining({
        itemId: target,
        knowledgeBaseId: w.entA,
        actor: expect.objectContaining({ id: w.editor }),
      }),
    );
    expect(policy.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ direction: 'in', items: result.items }),
    );
  });

  it('copies a folder subtree, authored page and backing file exactly once and inherits the target policy', async () => {
    const folder = await createDoc(db, {
      userId: w.editor,
      title: 'source folder',
      fileType: 'custom/folder',
    });
    const child = await createDoc(db, {
      userId: w.editor,
      parentId: folder,
      title: 'nested',
      content: 'authored page',
    });
    const fileId = await createKbFile(db, {
      userId: w.editor,
      parentId: folder,
      name: 'nested.txt',
    });
    await db.update(documents).set({ fileId }).where(eq(documents.id, child));
    policy.nodes.set(w.entAFolder, 'edit');
    const result = await caller().moveIn(input([folder, child, fileId], w.entAFolder));
    expect(result.items).toHaveLength(1);
    const target = result.items[0].targetId;
    const children = await db.select().from(documents).where(eq(documents.parentId, target));
    expect(children).toHaveLength(1);
    expect(children[0]).toMatchObject({
      userId: w.owner,
      knowledgeBaseId: w.entA,
      content: 'authored page',
    });
    expect(await row(children[0].fileId!)).toMatchObject({ userId: w.owner, parentId: target });
    expect(
      await db
        .select()
        .from(documents)
        .where(inArray(documents.id, [folder, child])),
    ).toHaveLength(0);
    expect(await row(fileId)).toBeUndefined();
    expect(
      await caller().resolveLevel({ knowledgeBaseId: w.entA, nodeId: children[0].id }),
    ).toEqual({ level: 'edit' });
    expect(policy.nodes.has(children[0].id)).toBe(false);
  });

  it('moves out to an ordinary personal folder, trashes the enterprise cascade, and allows owner restoration', async () => {
    const [targetKb] = await db
      .insert(knowledgeBases)
      .values({ userId: w.editor, name: 'My target library' })
      .returning();
    const personalFolder = await createDoc(db, {
      knowledgeBaseId: targetKb.id,
      userId: w.editor,
      title: 'personal',
      fileType: 'custom/folder',
    });
    const fileId = await createKbFile(db, {
      userId: w.owner,
      knowledgeBaseId: w.entA,
      parentId: w.entAFolder,
      name: 'inside.txt',
    });
    await db
      .update(documents)
      .set({ metadata: { knowledgeBaseId: w.entA, label: 'keep me' } })
      .where(eq(documents.id, w.entAFolder));
    const result = await caller().moveOut({
      ...input([w.entAFolder], personalFolder),
      targetKnowledgeBaseId: targetKb.id,
    });
    const target = result.items[0].targetId;
    const [folder] = await db.select().from(documents).where(eq(documents.id, target));
    expect(folder).toMatchObject({
      userId: w.editor,
      knowledgeBaseId: targetKb.id,
      parentId: personalFolder,
    });
    expect(folder.metadata).toMatchObject({ label: 'keep me' });
    expect(folder.metadata).toHaveProperty('knowledgeBaseId', targetKb.id);
    const [page] = await db.select().from(documents).where(eq(documents.parentId, target));
    expect(page).toMatchObject({ userId: w.editor, knowledgeBaseId: targetKb.id });
    const [copy] = await db.select().from(files).where(eq(files.parentId, target));
    expect(copy).toMatchObject({ userId: w.editor, workspaceId: null });
    expect(
      await db.select().from(knowledgeBaseFiles).where(eq(knowledgeBaseFiles.fileId, copy.id)),
    ).toMatchObject([{ knowledgeBaseId: targetKb.id, userId: w.editor }]);
    expect(await row(fileId)).toMatchObject({ isDeleted: true });
    const rows = await db.select().from(trashItems).where(eq(trashItems.userId, w.owner));
    expect(new Set(rows.map((r) => r.resourceId))).toEqual(
      new Set([w.entAFolder, w.entADoc, fileId]),
    );
    const root = rows.find((r) => r.resourceId === w.entAFolder)!;
    await enterpriseContentTrashHandler.restore(
      { db, userId: w.owner } as never,
      root,
      rows.filter((r) => r.id !== root.id),
    );
    expect(await row(fileId)).toMatchObject({ isDeleted: null });
    expect(policy.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ direction: 'out', items: result.items }),
    );
  });

  it('moves a file to the root of the caller’s own ordinary personal library', async () => {
    const [target] = await db
      .insert(knowledgeBases)
      .values({ userId: w.editor, name: 'Personal destination' })
      .returning();
    const result = await caller().moveOut({
      ...input([w.entAFile]),
      targetKnowledgeBaseId: target.id,
    });
    const copy = await row(result.items[0].targetId);
    expect(copy).toMatchObject({ userId: w.editor, workspaceId: null, parentId: null });
    expect(
      await db.select().from(knowledgeBaseFiles).where(eq(knowledgeBaseFiles.fileId, copy.id)),
    ).toMatchObject([{ knowledgeBaseId: target.id, userId: w.editor }]);
    expect(await row(w.entAFile)).toMatchObject({ isDeleted: true });
  });

  it('rejects foreign, enterprise, workspace and mismatched-folder move-out targets atomically', async () => {
    const [target] = await db
      .insert(knowledgeBases)
      .values({ userId: w.editor, name: 'Personal destination' })
      .returning();
    const ownEnterprise = await db
      .insert(knowledgeBases)
      .values({ userId: w.editor, name: 'My enterprise' })
      .returning();
    enterpriseKbState.kbs.set(ownEnterprise[0].id, { ownerId: w.editor, grants: {} });
    const [workspace] = await db
      .insert(workspaces)
      .values({ primaryOwnerId: w.editor, name: 'Workspace', slug: `ws-${w.editor}` })
      .returning();
    const [workspaceKb] = await db
      .insert(knowledgeBases)
      .values({ userId: w.editor, name: 'Workspace KB', workspaceId: workspace.id })
      .returning();
    const folder = await createDoc(db, {
      userId: w.editor,
      title: 'Orphan personal folder',
      fileType: 'custom/folder',
    });
    for (const destination of [
      { targetKnowledgeBaseId: w.personalKb },
      { targetKnowledgeBaseId: w.entA },
      { targetKnowledgeBaseId: ownEnterprise[0].id },
      { targetKnowledgeBaseId: workspaceKb.id },
      { targetKnowledgeBaseId: target.id, parentId: w.entAFolder },
      { targetKnowledgeBaseId: target.id, parentId: folder },
      { parentId: folder },
    ]) {
      await expect(
        caller().moveOut({ ...input([w.entAFile]), ...destination }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(await row(w.entAFile)).toMatchObject({ isDeleted: null });
    }
  });

  it('moves a standalone authored page in and out while preserving its content and editor data', async () => {
    const page = await new DocumentService(db, w.editor).createDocument({
      title: 'authored',
      content: 'page body',
      editorData: { type: 'doc', content: [] },
      fileType: 'custom/document',
    });
    const movedIn = await caller().moveIn(input([page.id]));
    const targetId = movedIn.items[0].targetId;
    const [copy] = await db.select().from(documents).where(eq(documents.id, targetId));
    expect(copy).toMatchObject({
      userId: w.owner,
      knowledgeBaseId: w.entA,
      content: 'page body',
      editorData: page.editorData,
    });
    const movedOut = await caller().moveOut(input([targetId]));
    const [personal] = await db
      .select()
      .from(documents)
      .where(eq(documents.id, movedOut.items[0].targetId));
    expect(personal).toMatchObject({
      userId: w.editor,
      knowledgeBaseId: null,
      parentId: null,
      content: 'page body',
      editorData: page.editorData,
    });
    expect(await db.select().from(documents).where(eq(documents.id, targetId))).toMatchObject([
      { isDeleted: true },
    ]);
  });

  it('also copies and deletes when the library owner moves their own personal file in', async () => {
    const result = await caller(w.owner).moveIn(input([w.personalFile]));
    expect(result.items[0].targetId).not.toBe(w.personalFile);
    expect(await row(w.personalFile)).toBeUndefined();
    expect(await row(result.items[0].targetId)).toMatchObject({ userId: w.owner });
  });

  it('retains original node policies in enterprise trash without copying them to personal content', async () => {
    policy.nodes.set(w.entAFolder, 'edit');
    const result = await caller().moveOut(input([w.entAFolder]));
    expect(policy.nodes.get(w.entAFolder)).toBe('edit');
    expect(policy.nodes.has(result.items[0].targetId)).toBe(false);
    const [original] = await db.select().from(documents).where(eq(documents.id, w.entAFolder));
    expect(original.isDeleted).toBe(true);
  });

  it('rejects a mixed batch with somebody else’s personal item before deleting any source', async () => {
    const mine = await createKbFile(db, { userId: w.editor, name: 'mine.txt' });
    await expect(caller().moveIn(input([mine, w.personalFile]))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(await row(mine)).toBeDefined();
    expect(await row(w.personalFile)).toBeDefined();
  });

  it.each(['viewer', 'stranger'] as const)(
    'refuses move-in and move-out for %s without changing originals',
    async (who) => {
      const personal = await createKbFile(db, { userId: w[who], name: 'readonly.txt' });
      const code = who === 'viewer' ? 'FORBIDDEN' : 'NOT_FOUND';
      await expect(caller(w[who]).moveIn(input([personal]))).rejects.toMatchObject({ code });
      await expect(caller(w[who]).moveOut(input([w.entAFile]))).rejects.toMatchObject({ code });
      expect(await row(personal)).toBeDefined();
      expect(await row(w.entAFile)).toMatchObject({ isDeleted: null });
    },
  );
  it('checks the target node, full subtree, personal ownership and the personal destination', async () => {
    const personal = await createKbFile(db, { userId: w.editor, name: 'personal.txt' });
    for (const level of [null, 'view'] as const) {
      policy.nodes.set(w.entAFolder, level);
      await expect(caller().moveIn(input([personal], w.entAFolder))).rejects.toMatchObject({
        code: level ? 'FORBIDDEN' : 'NOT_FOUND',
      });
      await expect(caller().moveOut(input([w.entAFolder]))).rejects.toMatchObject({
        code: level ? 'FORBIDDEN' : 'NOT_FOUND',
      });
    }
    policy.nodes.set(w.entAFolder, 'edit');
    policy.nodes.set(w.entADoc, 'view');
    await expect(caller().moveOut(input([w.entAFolder]))).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    policy.nodes.clear();
    await expect(caller().moveIn(input([w.personalFile]))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(caller().moveOut(input([w.entAFile], w.entAFolder))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(await row(personal)).toBeDefined();
    expect(await row(w.entAFile)).toMatchObject({ isDeleted: null });
  });
  it('refuses a path-only destination even when a child is editable', async () => {
    policy.nodes.set(w.entAFolder, null);
    policy.nodes.set(w.entADoc, 'edit');
    const personal = await createKbFile(db, { userId: w.editor, name: 'path.txt' });
    await expect(caller().moveIn(input([personal], w.entAFolder))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(caller().moveOut(input([w.entAFolder]))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
  it.each(['in', 'out'] as const)(
    'rolls back every database change when audit fails for move %s',
    async (direction) => {
      const source =
        direction === 'in'
          ? await createKbFile(db, { userId: w.editor, name: 'rollback.txt' })
          : w.entAFile;
      const beforeFiles = await db.select().from(files);
      const beforeDocs = await db.select().from(documents);
      policy.record.mockRejectedValueOnce(new Error('audit write failed'));
      await expect(
        direction === 'in' ? caller().moveIn(input([source])) : caller().moveOut(input([source])),
      ).rejects.toThrow('audit write failed');
      expect(await db.select().from(files)).toEqual(beforeFiles);
      expect(await db.select().from(documents)).toEqual(beforeDocs);
      expect(await db.select().from(trashItems).where(eq(trashItems.userId, w.owner))).toHaveLength(
        0,
      );
    },
  );
  it('does not lose a successful parsing status and refuses a still running parse', async () => {
    const fileId = await createKbFile(db, { userId: w.editor, name: 'parsed.txt' });
    const [task] = await db
      .insert(asyncTasks)
      .values({ userId: w.editor, status: 'processing', type: 'chunking' })
      .returning();
    await db.update(files).set({ chunkTaskId: task.id }).where(eq(files.id, fileId));
    await expect(caller().moveIn(input([fileId]))).rejects.toMatchObject({ code: 'CONFLICT' });
    await db.update(asyncTasks).set({ status: 'success' }).where(eq(asyncTasks.id, task.id));
    // A completed parse with embedding not started yet is still a processing file.
    await expect(caller().moveIn(input([fileId]))).rejects.toMatchObject({ code: 'CONFLICT' });
    const [embeddingTask] = await db
      .insert(asyncTasks)
      .values({ userId: w.editor, status: 'success', type: 'embedding' })
      .returning();
    await db.update(files).set({ embeddingTaskId: embeddingTask.id }).where(eq(files.id, fileId));
    const result = await caller().moveIn(input([fileId]));
    const copied = await row(result.items[0].targetId);
    expect(copied.chunkTaskId).not.toBe(task.id);
    expect(
      await db.select().from(asyncTasks).where(eq(asyncTasks.id, copied.chunkTaskId!)),
    ).toMatchObject([{ status: 'success', userId: w.owner }]);
  });
});

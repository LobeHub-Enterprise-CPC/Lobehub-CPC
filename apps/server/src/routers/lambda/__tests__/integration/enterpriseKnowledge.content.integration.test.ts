import type * as BusinessKnowledge from '@lobechat/business-knowledge';
// @vitest-environment node
import type { LobeChatDatabase } from '@lobechat/database';
import {
  asyncTasks,
  documents,
  files,
  knowledgeBaseFiles,
  trashItems,
} from '@lobechat/database/schemas';
import { getTestDB } from '@lobechat/database/test-utils';
import { eq } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { searchEnterpriseKnowledge } from '@/server/services/enterpriseKnowledge/search';
import { KnowledgeBaseSearchService } from '@/server/services/knowledgeBase';
import { knowledgeBaseRuntime } from '@/server/services/toolExecution/serverRuntimes/knowledgeBase';
import {
  enterpriseKbState,
  fakeBusinessKnowledge,
  resetEnterpriseKbState,
} from '@/server/test-utils/enterpriseKnowledgeFake';

import { chunkRouter } from '../../chunk';
import { documentRouter } from '../../document';
import { fileRouter } from '../../file';
import { knowledgeRouter } from '../../knowledge';
import { trashRouter } from '../../trash';
import {
  context,
  createChunk,
  createDoc,
  createKbFile,
  type EnterpriseWorld,
  seedEnterpriseWorld,
} from './enterpriseKnowledge.fixture';

vi.mock('@lobechat/business-knowledge', async (original) => ({
  ...(await original<typeof BusinessKnowledge>()),
  ...(await import('@/server/test-utils/enterpriseKnowledgeFake')).fakeBusinessKnowledge,
}));
let testDB: LobeChatDatabase;
vi.mock('@/database/core/db-adaptor', () => ({ getServerDB: vi.fn(() => testDB) }));
const delivery = vi.hoisted(() => vi.fn(async () => ({})));
vi.mock('@/server/modules/Hatchet/directDelivery', () => ({
  getDirectDeliveryClient: () => ({ publishJSON: delivery }),
}));
vi.mock('@/server/modules/Tenant/callbackUrl', () => ({
  buildTenantCallbackUrl: (path: string) => 'https://isolated.test' + path,
  buildTenantPublicUrl: (path: string) => 'https://isolated.test' + path,
}));
const storage = vi.hoisted(() => ({ isDev: false }));
vi.mock('@/utils/env', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  get isDev() {
    return storage.isDev;
  },
}));
vi.mock('@lobechat/database/tenant', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  requireTenantScope: () => ({ slug: 'acme', tenantId: 'tenant-1' }),
}));
vi.mock('@/envs/file', () => ({ fileEnv: { S3_SET_ACL: false, S3_PREVIEW_URL_EXPIRE_IN: 300 } }));
vi.mock('@/envs/redis', () => ({ getRedisConfig: () => ({ enabled: false }) }));
vi.mock('@/server/modules/S3', () => ({
  FileS3: vi.fn().mockImplementation(function () {
    return {
      deleteFile: vi.fn(),
      deleteFiles: vi.fn(),
      createPreSignedUrlForPreview: vi.fn(async (key: string) => `https://storage.test/${key}`),
      getFileMetadata: vi.fn(async () => ({ contentLength: 10 })),
    };
  }),
}));

const caller = (userId: string) => ({
  chunk: chunkRouter.createCaller(context(userId) as any),
  doc: documentRouter.createCaller(context(userId) as any),
  file: fileRouter.createCaller(context(userId) as any),
  knowledge: knowledgeRouter.createCaller(context(userId) as any),
  trash: trashRouter.createCaller(context(userId) as any),
});

describe('enterprise knowledge content boundaries', () => {
  let w: EnterpriseWorld;
  beforeAll(async () => {
    testDB = await getTestDB();
  });
  beforeEach(async () => {
    storage.isDev = false;
    resetEnterpriseKbState();
    w = await seedEnterpriseWorld(testDB);
  });

  it.each([true, false])(
    'lists and opens a native document with real file URL resolution (dev=%s)',
    async (isDev) => {
      storage.isDev = isDev;
      const doc = await caller(w.editor).doc.createDocument({
        knowledgeBaseId: w.entA,
        title: 'Native page',
        content: 'native document body',
      });
      const [file] = await testDB.select().from(files).where(eq(files.id, doc.fileId!));
      expect(file.url).toBe('internal://document/placeholder');

      for (const userId of [w.viewer, w.editor, w.owner]) {
        const c = caller(userId);
        const { items } = await c.file.getKnowledgeItems({ knowledgeBaseId: w.entA });
        const pages = items.filter((item) => item.id === doc.id);
        expect(pages).toHaveLength(1);
        expect(pages[0]).toMatchObject({
          fileId: doc.fileId,
          sourceType: 'file',
          fileType: 'custom/document',
          url: expect.stringContaining(`/f/${doc.fileId}`),
        });
        expect(items.find((item) => item.id === w.entAFile)?.url).toBe(
          `https://isolated.test/f/${w.entAFile}`,
        );
        expect(await c.doc.getDocumentById({ id: doc.id })).toMatchObject({
          content: 'native document body',
        });
        expect(await c.file.getReadableUrl({ id: doc.fileId! })).toEqual({ url: '' });
        expect(await c.file.getReadableUrl({ id: w.entAFile })).toEqual({
          url: `https://isolated.test/f/${w.entAFile}`,
        });
      }

      const personalDoc = await caller(w.owner).doc.createDocument({
        knowledgeBaseId: w.personalKb,
        title: 'Personal native page',
        content: 'personal document body',
      });
      const personal = await caller(w.owner).file.getKnowledgeItems({
        knowledgeBaseId: w.personalKb,
      });
      expect(personal.items.filter((item) => item.id === personalDoc.id)).toHaveLength(1);
      expect(await caller(w.owner).file.getReadableUrl({ id: personalDoc.fileId! })).toEqual({
        url: '',
      });

      await testDB
        .update(files)
        .set({ url: 'files/../private.txt' })
        .where(eq(files.id, w.entAFile));
      expect(await caller(w.viewer).file.getReadableUrl({ id: w.entAFile })).toEqual({
        url: `https://isolated.test/f/${w.entAFile}`,
      });
      await expect(
        caller(w.viewer).doc.updateDocument({ id: doc.id, content: 'forbidden' }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(caller(w.stranger).doc.getDocumentById({ id: doc.id })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    },
  );

  it('view reads library file lists, document bodies, URLs and chunks in the owner scope', async () => {
    await createChunk(testDB, w.owner, w.entAFile, 'A chunk');
    const c = caller(w.viewer);
    expect((await c.file.getFiles({ knowledgeBaseId: w.entA })).map((x) => x.id)).toContain(
      w.entAFile,
    );
    expect(
      (await c.file.getKnowledgeItems({ knowledgeBaseId: w.entA })).items.map((x) => x.id),
    ).toContain(w.entADoc);
    expect(
      (await c.knowledge.getKnowledgeItems({ knowledgeBaseId: w.entA })).map((x) => x.id),
    ).toContain(w.entAFile);
    expect((await c.doc.getDocumentById({ id: w.entADoc }))?.content).toBe(
      'enterprise A secret page',
    );
    expect((await c.file.getReadableUrl({ id: w.entAFile })).url).toBe(
      `https://isolated.test/f/${w.entAFile}`,
    );
    expect((await c.chunk.getChunksByFileId({ id: w.entAFile })).items[0]?.text).toBe('A chunk');
    expect((await c.chunk.getFileContents({ fileIds: [w.entADoc] }))[0]?.content).toBe(
      'enterprise A secret page',
    );
  });

  it('returns the verified library for a parsed citation whose stored library is null', async () => {
    const id = await createDoc(testDB, {
      content: 'parsed citation',
      title: 'derived',
      userId: w.owner,
    });
    expect(await caller(w.owner).doc.getDocumentById({ id })).toMatchObject({
      id,
      knowledgeBaseId: null,
      content: 'parsed citation',
    });
    await testDB
      .update(documents)
      .set({ fileId: w.entAFile, knowledgeBaseId: null, sourceType: 'file' })
      .where(eq(documents.id, id));
    expect(await caller(w.viewer).doc.getDocumentById({ id })).toMatchObject({
      id,
      knowledgeBaseId: w.entA,
      content: 'parsed citation',
      source: `https://isolated.test/f/${w.entAFile}`,
    });
    expect(
      (await testDB.select().from(documents).where(eq(documents.id, id)))[0].knowledgeBaseId,
    ).toBeNull();
    await expect(
      caller(w.viewer).doc.updateDocument({ id, content: 'not allowed' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller(w.stranger).doc.getDocumentById({ id })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('view cannot register uploads, create, rename, move, delete or retry', async () => {
    const c = caller(w.viewer);
    const requests = [
      () =>
        c.file.createFile({
          knowledgeBaseId: w.entA,
          fileType: 'text/plain',
          name: 'new.txt',
          size: 10,
          url: 'files/new.txt',
        }),
      () => c.doc.createDocument({ knowledgeBaseId: w.entA, title: 'new' }),
      () =>
        c.doc.createDocuments({
          documents: [{ knowledgeBaseId: w.entA, title: 'folder', fileType: 'custom/folder' }],
        }),
      () => c.doc.updateDocument({ id: w.entADoc, title: 'renamed' }),
      () => c.file.updateFile({ id: w.entAFile, parentId: w.entAFolder }),
      () => c.file.removeFile({ id: w.entAFile }),
      () => c.doc.deleteDocument({ id: w.entADoc }),
      () => c.file.deleteKnowledgeItemsByQuery({ knowledgeBaseId: w.entA }),
      () => c.chunk.retryParseFileTask({ id: w.entAFile }),
      () => c.chunk.createEmbeddingChunksTask({ id: w.entAFile }),
    ];
    for (const request of requests)
      await expect(request()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('edit creates owner-scoped documents, mirror files and folders, recording the real actor', async () => {
    const c = caller(w.editor);
    const doc = await c.doc.createDocument({
      knowledgeBaseId: w.entA,
      title: 'New page',
      content: 'hello',
    });
    expect(doc.userId).toBe(w.owner);
    expect(doc.fileId).toBeTruthy();
    const [file] = await testDB.select().from(files).where(eq(files.id, doc.fileId!));
    expect(file.userId).toBe(w.owner);
    const [link] = await testDB
      .select()
      .from(knowledgeBaseFiles)
      .where(eq(knowledgeBaseFiles.fileId, file.id));
    expect(link).toMatchObject({ knowledgeBaseId: w.entA, userId: w.owner });
    const folder = await c.doc.createDocument({
      title: 'Child folder',
      parentId: w.entAFolder,
      fileType: 'custom/folder',
    });
    expect(folder).toMatchObject({ userId: w.owner, knowledgeBaseId: w.entA });
    expect(enterpriseKbState.uploaders).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          itemId: doc.id,
          actor: expect.objectContaining({ id: w.editor, kind: 'member' }),
        }),
        expect.objectContaining({ itemId: file.id, knowledgeBaseId: w.entA }),
        expect.objectContaining({ itemId: folder.id }),
      ]),
    );
    await c.doc.updateDocument({ id: doc.id, title: 'Edited' });
    expect((await c.doc.getDocumentById({ id: doc.id }))?.title).toBe('Edited');
  });

  it('edit registers uploads as owner, with uploader attribution', async () => {
    const uploaded = await caller(w.editor).file.createFile({
      knowledgeBaseId: w.entA,
      fileType: 'text/plain',
      name: 'uploaded.txt',
      hash: 'enterprise-upload-hash',
      size: 10,
      url: 'files/uploaded.txt',
    });
    const [file] = await testDB.select().from(files).where(eq(files.id, uploaded.id));
    expect(file.userId).toBe(w.owner);
    expect(enterpriseKbState.uploaders).toContainEqual(
      expect.objectContaining({
        itemId: uploaded.id,
        knowledgeBaseId: w.entA,
        actor: expect.objectContaining({ id: w.editor }),
      }),
    );
  });

  it('edit deletion goes to the recycle bin; edit cannot restore or purge, owner can restore', async () => {
    await caller(w.editor).file.removeFile({ id: w.entAFile });
    const [file] = await testDB.select().from(files).where(eq(files.id, w.entAFile));
    expect(file.isDeleted).toBe(true);
    const [trash] = await testDB
      .select()
      .from(trashItems)
      .where(eq(trashItems.resourceId, w.entAFile));
    expect(trash).toMatchObject({ userId: w.owner, deletedByUserId: w.editor });
    for (const action of ['restore', 'purge'] as const) {
      await expect(caller(w.editor).trash[action]({ ids: [trash.id] })).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
    }
    await caller(w.owner).trash.restore({ ids: [trash.id] });
    expect((await caller(w.viewer).file.findById({ id: w.entAFile })).id).toBe(w.entAFile);
  });

  it.each(['stranger', 'viewer'] as const)(
    'rejects unrelated owner rows and an inaccessible enterprise library (%s)',
    async (who) => {
      const c = caller(w[who]);
      for (const id of [w.entBFile, w.personalFile]) {
        await expect(c.file.getReadableUrl({ id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
        await expect(c.chunk.getChunksByFileId({ id })).rejects.toMatchObject({
          code: 'NOT_FOUND',
        });
        await expect(c.chunk.getFileContents({ fileIds: [id] })).rejects.toMatchObject({
          code: 'NOT_FOUND',
        });
        await expect(
          new KnowledgeBaseSearchService(testDB, w[who]).getFileContents([id]),
        ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      }
      if (who === 'stranger') {
        await expect(c.file.getFiles({ knowledgeBaseId: w.entA })).rejects.toMatchObject({
          code: 'NOT_FOUND',
        });
        await expect(c.doc.getDocumentById({ id: w.entADoc })).rejects.toMatchObject({
          code: 'NOT_FOUND',
        });
      }
    },
  );

  it('does not widen a request by combining one allowed id with a foreign or missing id', async () => {
    for (const id of [w.personalFile, w.entBFile, 'file_missing']) {
      await expect(
        caller(w.editor).file.removeFiles({ ids: [w.entAFile, id] }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    }
    expect((await caller(w.owner).file.findById({ id: w.entAFile })).id).toBe(w.entAFile);
  });

  it('validates destination parents before owner-scoped writes', async () => {
    await expect(
      caller(w.editor).file.updateFile({ id: w.entAFile, parentId: w.entADoc }),
    ).resolves.toBeDefined();
    await expect(
      caller(w.editor).doc.createDocument({
        knowledgeBaseId: w.entB,
        parentId: w.entAFolder,
        title: 'cross library',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('fails closed on item reads even when the policy store throws', async () => {
    enterpriseKbState.resolveThrows = true;
    await expect(
      caller(w.viewer).chunk.getFileContents({ fileIds: [w.entADoc] }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it('queues parsing and embedding in the owner scope while retaining edit authorization', async () => {
    const c = caller(w.editor);
    const parsed = await c.chunk.createParseFileTask({ id: w.entAFile });
    const embedded = await c.chunk.createEmbeddingChunksTask({ id: w.entAFile });
    for (const id of [parsed.id, embedded.id]) {
      const [task] = await testDB.select().from(asyncTasks).where(eq(asyncTasks.id, id!));
      expect(task.userId).toBe(w.owner);
    }
    expect(delivery).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({ fileId: w.entAFile, userId: w.owner }),
      }),
    );
    await expect(c.chunk.retryParseFileTask({ id: w.entAFile })).resolves.toMatchObject({
      success: true,
    });
  });

  it('enterprise name search never expands into an owner personal library', async () => {
    const ctx = { serverDB: testDB, userId: w.viewer };
    const libraries = await searchEnterpriseKnowledge(ctx, {
      query: 'Enterprise',
      type: 'knowledgeBase',
    });
    expect(libraries.map((item) => item.id)).toEqual([w.entA]);
    const pages = await searchEnterpriseKnowledge(ctx, { query: 'Page', type: 'page' });
    expect(pages.map((item) => item.id)).toEqual([w.entADoc]);
    expect(
      await searchEnterpriseKnowledge({ ...ctx, userId: w.stranger }, { query: 'Page' }),
    ).toEqual([]);
  });

  it('folder deletion and restore retain all contained documents and refuse member purge', async () => {
    await caller(w.editor).doc.deleteDocument({ id: w.entAFolder });
    const [doc] = await testDB.select().from(documents).where(eq(documents.id, w.entADoc));
    expect(doc.isDeleted).toBe(true);
    const [root] = await testDB
      .select()
      .from(trashItems)
      .where(eq(trashItems.resourceId, w.entAFolder));
    await expect(caller(w.viewer).trash.restore({ ids: [root.id] })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await caller(w.owner).trash.restore({ ids: [root.id] });
    expect((await caller(w.viewer).doc.getDocumentById({ id: w.entADoc }))?.content).toBe(
      'enterprise A secret page',
    );
  });

  it('owner purge physically removes only the trashed enterprise file', async () => {
    await caller(w.editor).file.removeFile({ id: w.entAFile });
    const [root] = await testDB
      .select()
      .from(trashItems)
      .where(eq(trashItems.resourceId, w.entAFile));
    expect(await caller(w.owner).trash.purge({ ids: [root.id] })).toEqual({ purged: 1 });
    expect(await testDB.select().from(files).where(eq(files.id, w.entAFile))).toEqual([]);
    expect((await caller(w.owner).file.findById({ id: w.personalFile })).id).toBe(w.personalFile);
  });

  it('ignores unknown target fields instead of turning a personal list into the owner scope', async () => {
    await createKbFile(testDB, { userId: w.owner, name: 'unfiled-secret.txt' });
    await createDoc(testDB, {
      userId: w.owner,
      title: 'unfiled secret page',
      content: 'confidential',
    });
    const c = caller(w.viewer);
    const recent = await c.file.recentFiles({ id: w.entAFile, limit: 50 } as any);
    expect(recent).toEqual([]);
    const docs = await c.doc.queryDocuments({ id: w.entADoc } as any);
    expect(docs.items).toEqual([]);
    const personalUpload = await c.file.createFile({
      id: w.entAFile,
      name: 'own.txt',
      hash: 'own-file-hash',
      size: 10,
      fileType: 'text/plain',
      url: 'files/own.txt',
    } as any);
    const [row] = await testDB.select().from(files).where(eq(files.id, personalUpload.id));
    expect(row.userId).toBe(w.viewer);
  });

  it('rolls back enterprise rows when actual-uploader recording fails', async () => {
    fakeBusinessKnowledge.recordEnterpriseKbItemUploaders.mockRejectedValueOnce(
      new Error('attribution unavailable'),
    );
    await expect(
      caller(w.editor).doc.createDocument({ knowledgeBaseId: w.entA, title: 'must-rollback-page' }),
    ).rejects.toBeDefined();
    expect(
      await testDB.select().from(documents).where(eq(documents.title, 'must-rollback-page')),
    ).toEqual([]);
    expect(await testDB.select().from(files).where(eq(files.name, 'must-rollback-page'))).toEqual(
      [],
    );
    fakeBusinessKnowledge.recordEnterpriseKbItemUploaders.mockRejectedValueOnce(
      new Error('attribution unavailable'),
    );
    await expect(
      caller(w.editor).file.createFile({
        knowledgeBaseId: w.entA,
        name: 'must-rollback.txt',
        hash: 'rollback-hash',
        size: 10,
        fileType: 'text/plain',
        url: 'files/rollback.txt',
      }),
    ).rejects.toBeDefined();
    expect(await testDB.select().from(files).where(eq(files.name, 'must-rollback.txt'))).toEqual(
      [],
    );
  });

  it('enforces the same view/edit boundaries on runtime browsing and creation', async () => {
    const runtime = (id: string) =>
      knowledgeBaseRuntime.factory({ serverDB: testDB, userId: id, toolManifestMap: {} });
    expect((await runtime(w.viewer).viewKnowledgeBase({ id: w.entA })).success).toBe(true);
    expect((await runtime(w.stranger).viewKnowledgeBase({ id: w.entA })).success).toBe(false);
    expect(
      (
        await runtime(w.viewer).createDocument({
          knowledgeBaseId: w.entA,
          title: 'view attempt',
          content: 'not allowed',
        })
      ).success,
    ).toBe(false);
    expect(
      (
        await runtime(w.editor).createDocument({
          knowledgeBaseId: w.entA,
          title: 'runtime-created',
          content: 'allowed',
        })
      ).success,
    ).toBe(true);
    const [doc] = await testDB
      .select()
      .from(documents)
      .where(eq(documents.title, 'runtime-created'));
    expect(doc.userId).toBe(w.owner);
    expect(enterpriseKbState.uploaders).toContainEqual(
      expect.objectContaining({ itemId: doc.id, actor: expect.objectContaining({ id: w.editor }) }),
    );
    expect((await runtime(w.owner).deleteKnowledgeBase({ id: w.entA })).success).toBe(false);
  });
  it('hides enterprise content in owner-wide lists when current access resolution fails', async () => {
    enterpriseKbState.resolveThrows = true;
    const c = caller(w.owner);
    expect((await c.doc.queryDocuments()).items).toEqual([]);
    const list = await c.file.getFiles({ showFilesInKnowledgeBase: true });
    expect(list.map((item) => item.id)).toEqual([w.personalFile]);
  });
  it('does not let a document slug confer library access on a different canonical file id', async () => {
    await caller(w.editor).doc.createDocument({
      knowledgeBaseId: w.entA,
      title: 'alias trap',
      slug: w.personalFile,
    });
    await expect(
      caller(w.viewer).file.getReadableUrl({ id: w.personalFile }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('does not expose the chunks of a trashed enterprise file to viewers', async () => {
    await createChunk(testDB, w.owner, w.entAFile, 'trashed secret');
    await caller(w.editor).file.removeFile({ id: w.entAFile });
    await expect(
      caller(w.viewer).chunk.getChunksByFileId({ id: w.entAFile }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

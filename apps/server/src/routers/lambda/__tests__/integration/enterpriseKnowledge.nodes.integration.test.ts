import type * as BusinessKnowledge from '@lobechat/business-knowledge';
// @vitest-environment node
import type { EnterpriseKbUserTree } from '@lobechat/business-knowledge';
import type { LobeChatDatabase } from '@lobechat/database';
import { documents, embeddings, files, trashItems } from '@lobechat/database/schemas';
import { getTestDB } from '@lobechat/database/test-utils';
import { eq } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { FileModel } from '@/database/models/file';
import {
  ElasticsearchFtsSearchBackend,
  FtsSearchRepo,
  PgLikeFtsSearchBackend,
} from '@/database/repositories/ftsSearch';
import { KnowledgeRepo } from '@/database/repositories/knowledge';
import { DocumentService } from '@/server/services/document';
import {
  planRetrieval,
  resolveItemsScope,
  resolveKnowledgeBaseScope,
} from '@/server/services/enterpriseKnowledge';
import { resolveEnterpriseContentScopes } from '@/server/services/enterpriseKnowledge/contentAccess';
import { resolveContentScope } from '@/server/services/enterpriseKnowledge/contentScope';
import { queryEnterprisePage } from '@/server/services/enterpriseKnowledge/listAccess';
import {
  enterpriseContentTrashHandler,
  trashEnterpriseItems,
} from '@/server/services/enterpriseKnowledge/trash';
import { KnowledgeBaseSearchService } from '@/server/services/knowledgeBase';
import { knowledgeBaseRuntime } from '@/server/services/toolExecution/serverRuntimes/knowledgeBase';
import {
  enterpriseKbState,
  resetEnterpriseKbState,
} from '@/server/test-utils/enterpriseKnowledgeFake';

import { chunkRouter } from '../../chunk';
import { documentRouter } from '../../document';
import { enterpriseKnowledgeRouter } from '../../enterpriseKnowledge';
import { fileRouter } from '../../file';
import {
  context,
  createChunk,
  createDoc,
  createKbFile,
  type EnterpriseWorld,
  seedEnterpriseWorld,
} from './enterpriseKnowledge.fixture';

const policy = vi.hoisted(() => ({
  nodes: new Map<string, 'view' | 'edit' | null>(),
  es: false,
  hits: [] as { _id: string; _score: number }[],
  fail: false,
  enabled: true,
  removed: [] as string[],
  get: vi.fn(),
  update: vi.fn(),
}));
vi.mock('@lobechat/business-knowledge', async (original) => {
  const real = await original<typeof BusinessKnowledge>();
  const { fakeBusinessKnowledge: fake } =
    await import('@/server/test-utils/enterpriseKnowledgeFake');
  return {
    ...real,
    ...fake,
    resolveEnterpriseKbAccess: async (db: unknown, userId: string, id: string) => {
      const r = await fake.resolveEnterpriseKbAccess(db, userId, id);
      if (!r.enterprise) return r;
      const kb = enterpriseKbState.kbs.get(id)!;
      return {
        enterprise: true,
        access: r.access
          ? { ...r.access, hasNodePolicies: policy.enabled }
          : policy.enabled && policy.nodes.size
            ? { knowledgeBaseId: id, ownerId: kb.ownerId, level: 'path', hasNodePolicies: true }
            : null,
      };
    },
    resolveEnterpriseKbUserTree: async (
      _db: unknown,
      userId: string,
      id: string,
    ): Promise<EnterpriseKbUserTree> => {
      if (policy.fail) throw new Error('policy unavailable');
      const kb = enterpriseKbState.kbs.get(id)!;
      return {
        knowledgeBaseId: id,
        ownerId: kb.ownerId,
        libraryLevel: kb.grants[userId] ?? null,
        owner: kb.ownerId === userId,
        nodes: [...policy.nodes].map(([nodeId, level]) => ({ nodeId, level })),
      };
    },
    listEnterpriseKbNodePolicies: async () =>
      [...policy.nodes.keys()].map((nodeId) => ({ nodeId, version: 1 })),
    getEnterpriseKbNodeAccessState: policy.get,
    updateEnterpriseKbNodeAccess: policy.update,
    removeEnterpriseKbNodePolicies: async (_db: unknown, { nodeIds }: { nodeIds: string[] }) => {
      policy.removed.push(...nodeIds);
    },
  };
});
vi.mock('@/server/services/file', () => ({
  FileService: vi.fn().mockImplementation(function () {
    return {
      getFileBrowserUrl: async ({ id }: { id: string }) => '/f/' + id,
      getFileBrowserUrls: async (files: { id: string }[]) => files.map((file) => '/f/' + file.id),
    };
  }),
}));
vi.mock('@/server/globalConfig', () => ({ getServerDefaultFilesConfig: async () => ({}) }));
vi.mock('@/server/modules/ModelRuntime', () => ({
  initModelRuntimeFromDB: async () => ({
    embeddings: async () => [Array.from({ length: 1024 }, () => 0.1)],
  }),
}));
vi.mock('@/server/services/ftsSearch', () => ({
  createFtsSearchRepo: async ({
    db,
    userId,
    workspaceId,
  }: {
    db: LobeChatDatabase;
    userId: string;
    workspaceId?: string;
  }) =>
    new FtsSearchRepo(db, userId, workspaceId, undefined, {
      backend: policy.es
        ? new ElasticsearchFtsSearchBackend(db, {
            indexNamespace: 'isolated-node-test',
            client: { search: async () => ({ hits: { hits: policy.hits } }) },
          })
        : new PgLikeFtsSearchBackend(db, { userId, workspaceId }),
      ftsSearchCandidateEnabled: true,
    }),
}));
let db: LobeChatDatabase;
vi.mock('@/database/core/db-adaptor', () => ({ getServerDB: () => db }));

describe('enterprise node boundaries through real directory rows', () => {
  let w: EnterpriseWorld;
  let leaf: string;
  beforeAll(async () => {
    db = await getTestDB();
  });
  beforeEach(async () => {
    resetEnterpriseKbState();
    policy.nodes.clear();
    policy.es = false;
    policy.hits = [];
    policy.fail = false;
    policy.enabled = true;
    policy.removed = [];
    policy.get.mockReset();
    policy.update.mockReset();
    w = await seedEnterpriseWorld(db);
    leaf = await createKbFile(db, {
      knowledgeBaseId: w.entA,
      parentId: w.entAFolder,
      userId: w.owner,
      name: 'leaf.txt',
    });
    policy.nodes.set(w.entAFolder, null);
    policy.nodes.set(leaf, 'view');
  });
  const ctx = (id = w.editor) => ({ serverDB: db, userId: id });
  it('replaces root edit with path and hides ungranted siblings even by exact id', async () => {
    expect(await resolveItemsScope(ctx(), [w.entAFolder], 'path')).toMatchObject({ level: 'path' });
    await expect(resolveItemsScope(ctx(), [w.entADoc], 'view')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(
      resolveContentScope(ctx(), { knowledgeBaseId: w.entA, id: w.entADoc }, 'edit'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(resolveEnterpriseContentScopes(ctx(), [w.entADoc])).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(await resolveItemsScope(ctx(), [leaf], 'view')).toMatchObject({ level: 'view' });
    await expect(resolveItemsScope(ctx(), [leaf], 'edit')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
  it('checks both move ends, root destination and create destination', async () => {
    await expect(
      resolveContentScope(ctx(), { id: w.entAFile, parentId: w.entAFolder }, 'edit'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      resolveContentScope(ctx(), { id: w.entADoc, parentId: null }, 'edit'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      resolveContentScope(ctx(), { knowledgeBaseId: w.entA, parentId: w.entAFolder }, 'edit'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    policy.nodes.set(leaf, 'edit');
    expect(await resolveContentScope(ctx(), { id: leaf, parentId: null }, 'edit')).toMatchObject({
      enterprise: true,
    });
    await db.update(files).set({ parentId: null }).where(eq(files.id, leaf));
    expect(await resolveItemsScope(ctx(), [leaf], 'edit')).toMatchObject({ level: 'edit' });
    policy.nodes.delete(leaf);
    expect(await resolveItemsScope(ctx(), [leaf], 'edit')).toMatchObject({ level: 'edit' });
  });
  it('allows path library browsing/mounting but denies path content and root writes', async () => {
    enterpriseKbState.kbs.get(w.entA)!.grants = {};
    expect(await resolveKnowledgeBaseScope(ctx(), w.entA, 'path')).toMatchObject({ level: 'path' });
    await expect(resolveEnterpriseContentScopes(ctx(), [w.entAFile])).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(
      resolveContentScope(ctx(), { id: leaf, parentId: null }, 'edit'),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      resolveContentScope(ctx(), { knowledgeBaseId: w.entA }, 'edit'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const plan = await planRetrieval(ctx(), [w.entA], w.editor);
    expect(plan.skippedCount).toBe(0);
    expect(plan.enterpriseGroups[0].nodeAccess?.levels.get(leaf)).toBe('view');
  });
  it('filters lists before pagination and never exposes custom to members', async () => {
    const repo = new KnowledgeRepo(db, w.owner);
    const query = (page: { limit: number; offset: number }) =>
      repo.query({ ...page, knowledgeBaseId: w.entA, includeContent: true });
    const rows = await queryEnterprisePage(ctx(), query, { limit: 50 });
    expect(rows.map((row) => row.id)).not.toContain(w.entADoc);
    expect(rows.find((row) => row.id === w.entAFolder)).toMatchObject({
      enterpriseAccess: { level: 'path', custom: false },
      content: null,
    });
    expect(rows.find((row) => row.id === leaf)).toMatchObject({
      enterpriseAccess: { level: 'view', custom: false },
    });
    const first = await queryEnterprisePage(ctx(), query, { limit: 1 });
    const second = await queryEnterprisePage(ctx(), query, { limit: 1, offset: 1 });
    expect([first[0].id, second[0].id]).toEqual(rows.slice(0, 2).map((row) => row.id));
    expect(
      (await queryEnterprisePage(ctx(w.owner), query, { limit: 50 })).find(
        (row) => row.id === w.entAFolder,
      ),
    ).toMatchObject({ enterpriseAccess: { level: 'owner', custom: true } });
  });
  it('follows mirror file policy instead of its own directory or policy', async () => {
    const mirror = await createDoc(db, {
      title: 'Mirror',
      knowledgeBaseId: w.entA,
      userId: w.owner,
    });
    await db
      .update(documents)
      .set({ fileId: leaf, sourceType: 'file' })
      .where(eq(documents.id, mirror));
    policy.nodes.set(mirror, 'edit');
    expect(await resolveItemsScope(ctx(), [mirror], 'view')).toMatchObject({ level: 'view' });
    await expect(resolveItemsScope(ctx(), [mirror], 'edit')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    policy.nodes.set(leaf, null);
    await expect(resolveEnterpriseContentScopes(ctx(), [mirror])).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
  it('fails closed on tree errors but skips the tree when there are no policies', async () => {
    policy.fail = true;
    await expect(resolveItemsScope(ctx(), [w.entAFile], 'view')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    policy.enabled = false;
    expect(await resolveItemsScope(ctx(), [w.entAFile], 'edit')).toMatchObject({ level: 'edit' });
  });
  it.each(['viewer', 'editor', 'stranger'] as const)(
    'hides all node policy APIs from %s',
    async (who) => {
      const caller = enterpriseKnowledgeRouter.createCaller(context(w[who]) as never);
      for (const call of [
        () => caller.getNodeAccess({ knowledgeBaseId: w.entA, nodeId: leaf }),
        () =>
          caller.updateNodeAccess({
            knowledgeBaseId: w.entA,
            nodeId: leaf,
            mode: 'custom',
            version: 0,
            grants: [],
          }),
        () =>
          caller.estimateNodeAccess({
            knowledgeBaseId: w.entA,
            nodeId: leaf,
            mode: 'custom',
            grants: [],
          }),
      ])
        await expect(call()).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(policy.get).not.toHaveBeenCalled();
    },
  );
  it('builds node metadata server-side and maps optimistic conflicts', async () => {
    const caller = enterpriseKnowledgeRouter.createCaller(context(w.owner) as never);
    policy.get.mockResolvedValue({
      mode: 'inherit',
      grants: [],
      version: 0,
      inheritedFromNodeId: w.entAFolder,
    });
    const result = await caller.getNodeAccess({ knowledgeBaseId: w.entA, nodeId: leaf });
    expect(result).toMatchObject({
      node: { id: leaf, kind: 'file', name: 'leaf.txt' },
      inheritedFrom: { id: w.entAFolder, name: 'Folder A' },
    });
    policy.update.mockRejectedValue({ code: 'STALE_VERSION' });
    await expect(
      caller.updateNodeAccess({
        knowledgeBaseId: w.entA,
        nodeId: leaf,
        mode: 'custom',
        version: 0,
        grants: [],
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(policy.update.mock.calls[0][1]).toMatchObject({
      ancestorIds: [w.entAFolder],
      nodeKind: 'file',
      nodeName: 'leaf.txt',
      actor: { id: w.owner, kind: 'member' },
    });
    await expect(
      caller.getNodeAccess({ knowledgeBaseId: w.entA, nodeId: w.entBFile }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it('keeps authored page policies on the document and guards its backing file', async () => {
    const doc = await new DocumentService(db, w.owner).createDocument({
      title: 'Page with backing file',
      content: 'private authored content',
      editorData: {},
      fileType: 'custom/document',
      knowledgeBaseId: w.entA,
    });
    policy.nodes.set(doc.id, null);
    await expect(resolveItemsScope(ctx(), [doc.id], 'view')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(resolveEnterpriseContentScopes(ctx(), [doc.fileId!])).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    const caller = enterpriseKnowledgeRouter.createCaller(context(w.owner) as never);
    policy.get.mockResolvedValue({
      mode: 'custom',
      grants: [],
      version: 1,
      inheritedFromNodeId: null,
    });
    expect(await caller.getNodeAccess({ knowledgeBaseId: w.entA, nodeId: doc.id })).toMatchObject({
      node: { id: doc.id, kind: 'document' },
    });
  });
  it('filters both retrieval paths before topK without counting hidden files as skipped libraries', async () => {
    const hidden = await createDoc(db, {
      title: 'needle hidden',
      content: 'needle hidden',
      knowledgeBaseId: w.entA,
      parentId: w.entAFolder,
      userId: w.owner,
    });
    const visible = await createDoc(db, {
      title: 'needle visible',
      content: 'needle visible',
      knowledgeBaseId: w.entA,
      parentId: w.entAFolder,
      userId: w.owner,
    });
    policy.nodes.set(visible, 'view');
    const hiddenFile = await createKbFile(db, {
      knowledgeBaseId: w.entA,
      parentId: w.entAFolder,
      userId: w.owner,
      name: 'hidden.txt',
    });
    const hiddenChunk = await createChunk(db, w.owner, hiddenFile, 'needle hidden vector');
    const visibleChunk = await createChunk(db, w.owner, leaf, 'needle visible vector');
    await db.insert(embeddings).values(
      [hiddenChunk, visibleChunk].map((chunkId) => ({
        chunkId,
        userId: w.owner,
        embeddings: Array.from({ length: 1024 }, () => 0.1),
        model: 'test',
      })),
    );
    const result = await new KnowledgeBaseSearchService(
      db,
      w.editor,
      undefined,
      undefined,
      w.editor,
    ).semanticSearchForChat({ knowledgeIds: [w.entA], query: 'needle', topK: 1 });
    expect(result.chunks.map((hit) => hit.fileId)).toEqual([leaf]);
    expect(result.documents.map((hit) => hit.documentId)).toEqual([visible]);
    expect(result.documents.map((hit) => hit.documentId)).not.toContain(hidden);
    expect(result.skippedKnowledgeBaseCount).toBeUndefined();
    expect(
      (
        await new KnowledgeBaseSearchService(
          db,
          w.editor,
          undefined,
          undefined,
          null,
        ).semanticSearchForChat({ knowledgeIds: [w.entA], query: 'needle' })
      ).documents,
    ).toEqual([]);
  });
  it('cleans all policies when permanently deleting a folder cascade, retaining them in trash', async () => {
    const scope = await resolveItemsScope(ctx(w.owner), [w.entAFolder], 'edit');
    if (!scope.enterprise) throw new Error('expected enterprise');
    await trashEnterpriseItems(ctx(w.owner), scope, [w.entAFolder]);
    expect(policy.removed).toEqual([]);
    const rows = await db.select().from(trashItems).where(eq(trashItems.userId, w.owner));
    const root = rows.find((row) => row.resourceId === w.entAFolder)!;
    await enterpriseContentTrashHandler.purge(
      { db, userId: w.owner, fileService: { deleteFiles: vi.fn() } } as never,
      root,
      rows.filter((row) => row.id !== root.id),
    );
    expect(new Set(policy.removed)).toEqual(new Set([w.entAFolder, w.entADoc, leaf]));
    expect(await new FileModel(db, w.owner).findById(leaf)).toBeUndefined();
  });
  it('rejects exact-id reads, previews, chunks, retries and moves through the public routers', async () => {
    const f = fileRouter.createCaller(context(w.editor) as never);
    const d = documentRouter.createCaller(context(w.editor) as never);
    const c = chunkRouter.createCaller(context(w.editor) as never);
    for (const call of [
      () => d.getDocumentById({ id: w.entADoc }),
      () => c.getFileContents({ fileIds: [w.entADoc] }),
      () => f.getReadableUrl({ id: w.entADoc }),
      () => c.getChunksByFileId({ id: w.entADoc }),
      () => c.retryParseFileTask({ id: w.entADoc }),
      () => f.updateFile({ id: w.entAFile, parentId: w.entAFolder }),
    ])
      await expect(call()).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const caller = enterpriseKnowledgeRouter.createCaller(context(w.editor) as never);
    expect(await caller.resolveLevel({ knowledgeBaseId: w.entA, nodeId: w.entAFolder })).toEqual({
      level: 'path',
    });
  });
  it('filters runtime browsing and forbids hidden detail reads and creates into path folders', async () => {
    enterpriseKbState.kbs.get(w.entA)!.grants = {};
    const runtime = knowledgeBaseRuntime.factory({
      serverDB: db,
      userId: w.editor,
      toolManifestMap: {},
    });
    const result = await runtime.viewKnowledgeBase({ id: w.entA });
    expect(result.success).toBe(true);
    expect(result.state).toMatchObject({
      files: expect.arrayContaining(
        [{ id: w.entAFolder }, { id: leaf }].map((row) => expect.objectContaining(row)),
      ),
    });
    expect((result.state as { files: { id: string }[] }).files.map((row) => row.id)).not.toContain(
      w.entADoc,
    );
    expect((await runtime.readKnowledge({ fileIds: [w.entADoc] })).success).toBe(false);
    expect(
      (
        await runtime.createDocument({
          knowledgeBaseId: w.entA,
          parentId: w.entAFolder,
          title: 'Cannot create',
        })
      ).success,
    ).toBe(false);
  });
  it('filters Elasticsearch full-text candidates before topK, keeping a visible lower-ranked hit', async () => {
    const hidden = await createDoc(db, {
      title: 'needle hidden',
      content: 'needle hidden',
      knowledgeBaseId: w.entA,
      parentId: w.entAFolder,
      userId: w.owner,
    });
    const visible = await createDoc(db, {
      title: 'needle visible',
      content: 'needle visible',
      knowledgeBaseId: w.entA,
      parentId: w.entAFolder,
      userId: w.owner,
    });
    policy.nodes.set(visible, 'view');
    policy.es = true;
    policy.hits = [
      { _id: hidden, _score: 10 },
      { _id: visible, _score: 1 },
    ];
    const result = await new KnowledgeBaseSearchService(
      db,
      w.editor,
      undefined,
      undefined,
      w.editor,
    ).semanticSearchForChat({ knowledgeIds: [w.entA], query: 'needle', topK: 1 });
    expect(result.documents.map((hit) => hit.documentId)).toEqual([visible]);
    expect(result.errors).toBeUndefined();
  });
});

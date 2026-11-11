import type * as BusinessKnowledge from '@lobechat/business-knowledge';
// @vitest-environment node
import type { LobeChatDatabase } from '@lobechat/database';
import {
  agents,
  agentsKnowledgeBases,
  chunks,
  embeddings,
  fileChunks,
} from '@lobechat/database/schemas';
import { getTestDB } from '@lobechat/database/test-utils';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentModel } from '@/database/models/agent';
import {
  ElasticsearchFtsSearchBackend,
  FtsSearchRepo,
  PgLikeFtsSearchBackend,
} from '@/database/repositories/ftsSearch';
import { KnowledgeBaseSearchService } from '@/server/services/knowledgeBase';
import { knowledgeBaseRuntime } from '@/server/services/toolExecution/serverRuntimes/knowledgeBase';
import {
  enterpriseKbState,
  resetEnterpriseKbState,
} from '@/server/test-utils/enterpriseKnowledgeFake';

import { chunkRouter } from '../../chunk';
import { context } from './enterpriseKnowledge.fixture';
import {
  createDoc,
  type EnterpriseWorld,
  seedEnterpriseWorld,
} from './enterpriseKnowledge.fixture';

vi.mock('@lobechat/business-knowledge', async (original) => ({
  ...(await original<typeof BusinessKnowledge>()),
  ...(await import('@/server/test-utils/enterpriseKnowledgeFake')).fakeBusinessKnowledge,
}));
vi.mock('@/server/services/file', () => ({ FileService: vi.fn() }));
vi.mock('@/server/globalConfig', () => ({ getServerDefaultFilesConfig: vi.fn(async () => ({})) }));
vi.mock('@/server/modules/ModelRuntime', () => ({
  initModelRuntimeFromDB: vi.fn(async () => ({
    embeddings: vi.fn(async () => [Array.from({ length: 1024 }, () => 0.1)]),
  })),
}));
const fts = vi.hoisted(() => ({
  es: false,
  hits: [] as { _id: string; _score: number }[],
  search: vi.fn(),
}));
vi.mock('@/server/services/ftsSearch', () => ({
  createFtsSearchRepo: vi.fn(
    async ({ db, userId, workspaceId, callerAgentVisibility }) =>
      new FtsSearchRepo(db, userId, workspaceId, callerAgentVisibility, {
        backend: fts.es
          ? new ElasticsearchFtsSearchBackend(db, {
              indexNamespace: 'isolated-ekb',
              client: {
                search: async (input) => {
                  fts.search(input);
                  return { hits: { hits: fts.hits } };
                },
              },
            })
          : new PgLikeFtsSearchBackend(db, { userId, workspaceId, callerAgentVisibility }),
        ftsSearchCandidateEnabled: true,
      }),
  ),
}));

let db: LobeChatDatabase;
vi.mock('@/database/core/db-adaptor', () => ({ getServerDB: vi.fn(() => db) }));
describe('enterprise retrieval uses the actual asker and exact library membership', () => {
  let w: EnterpriseWorld;
  beforeAll(async () => {
    db = await getTestDB();
  });
  beforeEach(async () => {
    resetEnterpriseKbState();
    fts.es = false;
    fts.hits = [];
    fts.search.mockClear();
    w = await seedEnterpriseWorld(db);
  });

  it('searches only the permitted mounted library and reports a skipped count', async () => {
    await createDoc(db, {
      userId: w.owner,
      knowledgeBaseId: w.entB,
      title: 'Denied secret page',
      content: 'enterprise B secret page',
    });
    await createDoc(db, {
      userId: w.owner,
      knowledgeBaseId: w.personalKb,
      title: 'Personal secret page',
      content: 'personal secret page',
    });
    for (const [fileId, text] of [
      [w.entAFile, 'allowed vector'],
      [w.entBFile, 'denied vector'],
      [w.personalFile, 'private vector'],
    ]) {
      const [row] = await db.insert(chunks).values({ userId: w.owner, index: 0, text }).returning();
      await db.insert(fileChunks).values({ chunkId: row.id, fileId, userId: w.owner });
      await db.insert(embeddings).values({
        chunkId: row.id,
        userId: w.owner,
        embeddings: Array.from({ length: 1024 }, () => 0.1),
      });
    }
    const result = await new KnowledgeBaseSearchService(
      db,
      w.viewer,
      undefined,
      undefined,
      w.viewer,
    ).semanticSearchForChat({ knowledgeIds: [w.entA, w.entB], query: 'secret' });
    expect(result.skippedKnowledgeBaseCount).toBe(1);
    expect(result.chunks.map((item) => item.text)).toEqual(['allowed vector']);
    expect(result.errors).toBeUndefined();
    expect(result.documents.map((item) => item.documentId)).toEqual([w.entADoc]);
    expect(result.documents.every((item) => item.knowledgeBaseId === w.entA)).toBe(true);
  });

  it.each([null, 'missing'])(
    'never searches an enterprise library for an unknown asker (%s)',
    async (asker) => {
      const result = await new KnowledgeBaseSearchService(
        db,
        w.owner,
        undefined,
        undefined,
        asker === 'missing' ? null : asker,
      ).semanticSearchForChat({ knowledgeIds: [w.entA, w.entB], query: 'secret' });
      expect(result).toMatchObject({
        chunks: [],
        documents: [],
        fileResults: [],
        skippedKnowledgeBaseCount: 2,
      });
    },
  );

  it('returns no enterprise results when current access resolution throws', async () => {
    enterpriseKbState.resolveThrows = true;
    const result = await new KnowledgeBaseSearchService(
      db,
      w.viewer,
      undefined,
      undefined,
      w.viewer,
    ).semanticSearchForChat({ knowledgeIds: [w.entA], query: 'secret' });
    expect(result).toMatchObject({ documents: [], chunks: [], skippedKnowledgeBaseCount: 1 });
  });

  it('share visitors cannot read enterprise content through the runtime, even running as owner', async () => {
    const runtime = knowledgeBaseRuntime.factory({
      serverDB: db,
      userId: w.owner,
      toolManifestMap: {},
      agentShareVisitor: { visitorId: 'visitor' },
    } as any);
    const result = await runtime.searchKnowledgeBase(
      { query: 'secret' },
      { knowledgeBaseIds: [w.entA] },
    );
    expect(result.success).toBe(true);
    expect(result.state).toMatchObject({ chunks: [], documents: [], skippedKnowledgeBaseCount: 1 });
    const read = await runtime.readKnowledge({ fileIds: [w.entADoc] });
    expect(read.success).toBe(false);
    expect(read.content).not.toContain('enterprise A secret page');
  });
  it('keeps Elasticsearch candidates and authoritative hydration inside the granted library', async () => {
    const deniedDoc = await createDoc(db, {
      userId: w.owner,
      knowledgeBaseId: w.entB,
      title: 'denied page',
      content: 'denied secret',
    });
    const privateDoc = await createDoc(db, {
      userId: w.owner,
      title: 'personal page',
      content: 'private secret',
    });
    fts.es = true;
    fts.hits = [privateDoc, deniedDoc, w.entADoc].map((id, index) => ({
      _id: id,
      _score: 10 - index,
    }));
    const result = await new KnowledgeBaseSearchService(
      db,
      w.viewer,
      undefined,
      undefined,
      w.viewer,
    ).semanticSearchForChat({ knowledgeIds: [w.entA, w.entB], query: 'secret' });
    expect(result.documents.map((item) => item.documentId)).toEqual([w.entADoc]);
    expect(result.skippedKnowledgeBaseCount).toBe(1);
    const query = JSON.stringify(fts.search.mock.calls);
    expect(query).toContain(w.owner);
    expect(query).toContain(w.entA);
    expect(query).not.toContain(w.entB);
  });
  it('does not leak enterprise chunks through an unscoped vector search after a policy failure', async () => {
    for (const [fileId, text] of [
      [w.entAFile, 'enterprise hidden'],
      [w.personalFile, 'personal allowed'],
    ]) {
      const [row] = await db.insert(chunks).values({ userId: w.owner, index: 0, text }).returning();
      await db.insert(fileChunks).values({ chunkId: row.id, fileId, userId: w.owner });
      await db.insert(embeddings).values({
        chunkId: row.id,
        userId: w.owner,
        embeddings: Array.from({ length: 1024 }, () => 0.1),
      });
    }
    enterpriseKbState.resolveThrows = true;
    const result = await chunkRouter
      .createCaller(context(w.owner) as any)
      .semanticSearch({ query: 'hidden' });
    expect(result.map((item) => item.text)).toEqual(['personal allowed']);
  });
  it('searches an assistant with both a valid and a revoked mount, keeping the revoked identity and count', async () => {
    const agentId = 'agt_' + w.viewer;
    await db.insert(agents).values({ id: agentId, slug: agentId, userId: w.viewer });
    await db.insert(agentsKnowledgeBases).values(
      [w.entA, w.entB].map((knowledgeBaseId) => ({
        agentId,
        knowledgeBaseId,
        userId: w.viewer,
        enabled: true,
      })),
    );
    const mounts = await new AgentModel(db, w.viewer).getAgentAssignedKnowledge(agentId);
    expect(mounts.knowledgeBases.find((item) => item.id === w.entB)).toMatchObject({
      accessRevoked: true,
      id: w.entB,
      name: 'Enterprise B',
    });
    const runtime = knowledgeBaseRuntime.factory({
      agentId,
      serverDB: db,
      userId: w.viewer,
      toolManifestMap: {},
    });
    const result = await runtime.searchKnowledgeBase({ query: 'secret' });
    expect(result.success).toBe(true);
    expect(result.state).toMatchObject({
      skippedKnowledgeBaseCount: 1,
      documents: [expect.objectContaining({ documentId: w.entADoc, knowledgeBaseId: w.entA })],
    });
  });
});

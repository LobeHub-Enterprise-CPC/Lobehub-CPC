import type { EnterpriseKbNodeAccessState } from '@lobechat/business-knowledge';
import * as business from '@lobechat/business-knowledge';
import { eq } from 'drizzle-orm';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import {
  documents,
  files,
  knowledgeBaseFiles,
  knowledgeBases,
  trashItems,
  users,
} from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';

const mocks = vi.hoisted(() => ({
  db: undefined as unknown,
  enabled: true,
  ids: new Set<string>(),
}));
vi.mock('@/database/core/db-adaptor', () => ({ getServerDB: async () => mocks.db }));
vi.mock('@/envs/app', () => ({ appEnv: { COMMAND_GOVERNANCE_SERVICE_TOKEN: 'test-token' } }));
vi.mock('@/server/services/file/impls', () => ({
  createFileServiceModule: () => ({ deleteFiles: vi.fn() }),
}));
vi.mock('@/server/modules/ContentChunk', () => ({ ContentChunk: class {} }));
vi.mock('@lobechat/business-knowledge', async (original) => ({
  ...(await original<typeof business>()),
  isEnterpriseKnowledgeEnabled: () => mocks.enabled,
  listEnterpriseKbIds: async (_db: unknown, ids?: string[]) =>
    [...mocks.ids].filter((id) => !ids || ids.includes(id)),
  listEnterpriseKbNodePolicies: vi.fn(async () => []),
  getEnterpriseKbNodeAccessState: vi.fn(),
  updateEnterpriseKbNodeAccess: vi.fn(),
  estimateEnterpriseKbNodeAccess: vi.fn(),
  removeEnterpriseKbNodePolicies: vi.fn(),
  listEnterpriseKbEvents: vi.fn(),
}));

const app = (await import('../index')).default;
const actor = { id: 'node-admin', name: '治理管理员' };
const owner = 'node-access-owner';
const prefix = '/api/governance/knowledge-bases';
let db: LobeChatDatabase;
const request = (
  method: string,
  path: string,
  body?: unknown,
  token: string | null = 'test-token',
) =>
  app.request(prefix + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const json = async (method: string, path: string, body?: unknown, status = 200) => {
  const res = await request(method, path, body);
  const data = await res.json();
  expect({ status: res.status, data }).toEqual({ status, data: expect.anything() });
  return data;
};
const library = async (name = '节点库') => {
  const [kb] = await db.insert(knowledgeBases).values({ name, userId: owner }).returning();
  mocks.ids.add(kb.id);
  return kb.id;
};
const document = async (
  kb: string,
  name: string,
  parentId: string | null = null,
  folder = true,
) => {
  const [doc] = await db
    .insert(documents)
    .values({
      userId: owner,
      knowledgeBaseId: kb,
      parentId,
      title: name,
      fileType: folder ? 'custom/folder' : 'custom/document',
      sourceType: 'api',
      source: '',
      totalCharCount: 0,
      totalLineCount: 0,
    })
    .returning();
  return doc.id;
};
const file = async (kb: string, parentId: string) => {
  const [row] = await db
    .insert(files)
    .values({
      userId: owner,
      parentId,
      name: '网关.txt',
      size: 0,
      fileType: 'text/plain',
      url: 'test/node-access',
    })
    .returning();
  await db
    .insert(knowledgeBaseFiles)
    .values({ knowledgeBaseId: kb, fileId: row.id, userId: owner });
  return row.id;
};
const inherit: EnterpriseKbNodeAccessState = {
  mode: 'inherit',
  version: 0,
  grants: [],
  inheritedFromNodeId: null,
};

beforeAll(async () => {
  db = await getTestDB();
  mocks.db = db;
}, 120000);
beforeEach(async () => {
  vi.resetAllMocks();
  mocks.enabled = true;
  mocks.ids.clear();
  vi.mocked(business.listEnterpriseKbNodePolicies).mockResolvedValue([]);
  vi.mocked(business.getEnterpriseKbNodeAccessState).mockResolvedValue(inherit);
  vi.mocked(business.updateEnterpriseKbNodeAccess).mockResolvedValue(inherit);
  vi.mocked(business.listEnterpriseKbEvents).mockResolvedValue([]);
  await db.insert(users).values({ id: owner }).onConflictDoNothing();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await db.delete(users).where(eq(users.id, owner));
});

describe('governance node access contract', () => {
  it('guards all node access endpoints with the existing token and capability gate', async () => {
    for (const [method, suffix] of [
      ['GET', '/access'],
      ['PUT', '/access'],
      ['POST', '/access/estimate'],
    ]) {
      const path = '/missing/items/missing' + suffix;
      for (const token of [null, 'wrong'])
        expect((await request(method, path, undefined, token)).status).toBe(401);
      mocks.enabled = false;
      expect(await json(method, path, undefined, 501)).toMatchObject({
        error: { code: 'NOT_ENABLED' },
      });
    }
  });

  it('derives node identity and nearest-first ancestors from the library tree', async () => {
    const kb = await library();
    const root = await document(kb, '研发');
    const parent = await document(kb, '接口文档', root);
    const node = await file(kb, parent);
    vi.mocked(business.getEnterpriseKbNodeAccessState).mockResolvedValue({
      ...inherit,
      inheritedFromNodeId: root,
    });
    expect(await json('GET', `/${kb}/items/${node}/access`)).toEqual({
      ...inherit,
      inheritedFromNodeId: root,
      inheritedFrom: { id: root, name: '研发' },
      node: { id: node, kind: 'file', name: '网关.txt' },
    });
    expect(business.getEnterpriseKbNodeAccessState).toHaveBeenCalledWith(db, {
      ancestorIds: [parent, root],
      knowledgeBaseId: kb,
      nodeId: node,
    });
    vi.mocked(business.getEnterpriseKbNodeAccessState).mockResolvedValue(inherit);
    expect(await json('GET', `/${kb}/items/${root}/access`)).toMatchObject({
      inheritedFrom: { id: null, name: '节点库' },
      node: { id: root, kind: 'folder', name: '研发' },
    });
    const page = await document(kb, '文稿', parent, false);
    expect(await json('GET', `/${kb}/items/${page}/access`)).toMatchObject({
      node: { id: page, kind: 'document' },
    });
  });

  it('refuses foreign, missing, trashed and mirror-only node ids on all three endpoints', async () => {
    const kb = await library();
    const other = await library('其他库');
    const foreign = await document(other, '外库文件夹');
    const trash = await document(kb, '已删除');
    await db.update(documents).set({ isDeleted: true }).where(eq(documents.id, trash));
    const parent = await document(kb, '文件夹');
    const source = await file(kb, parent);
    const [mirror] = await db
      .insert(documents)
      .values({
        userId: owner,
        knowledgeBaseId: kb,
        fileId: source,
        sourceType: 'file',
        fileType: 'custom/document',
        title: '解析镜像',
        source: '',
        totalCharCount: 0,
        totalLineCount: 0,
      })
      .returning();
    for (const id of [foreign, 'missing', trash, mirror.id]) {
      for (const [method, suffix, body] of [
        ['GET', '/access', undefined],
        ['PUT', '/access', { mode: 'custom', version: 0, grants: [], actor }],
        ['POST', '/access/estimate', { mode: 'inherit', grants: [] }],
      ] as const) {
        expect(await json(method, `/${kb}/items/${id}${suffix}`, body, 404)).toMatchObject({
          error: { code: 'NOT_FOUND' },
        });
      }
    }
    expect(business.updateEnterpriseKbNodeAccess).not.toHaveBeenCalled();
    expect(business.getEnterpriseKbNodeAccessState).not.toHaveBeenCalled();
    expect(business.estimateEnterpriseKbNodeAccess).not.toHaveBeenCalled();
  });

  it('accepts both modes, derives event metadata, estimates and maps version/principal errors safely', async () => {
    const kb = await library();
    const node = await document(kb, '接口文档');
    const path = `/${kb}/items/${node}/access`;
    const custom = { ...inherit, mode: 'custom' as const, version: 1 };
    vi.mocked(business.updateEnterpriseKbNodeAccess).mockResolvedValueOnce(custom);
    expect(
      await json('PUT', path, {
        mode: 'custom',
        version: 0,
        grants: [],
        actor,
        nodeName: '伪造',
        nodeKind: 'file',
        ancestorIds: ['foreign'],
      }),
    ).toMatchObject({
      mode: 'custom',
      version: 1,
      node: { id: node, kind: 'folder', name: '接口文档' },
    });
    expect(business.updateEnterpriseKbNodeAccess).toHaveBeenLastCalledWith(expect.anything(), {
      knowledgeBaseId: kb,
      nodeId: node,
      ancestorIds: [],
      nodeKind: 'folder',
      nodeName: '接口文档',
      mode: 'custom',
      version: 0,
      grants: [],
      actor: { ...actor, kind: 'admin' },
    });
    expect(
      await json('PUT', path, { mode: 'inherit', version: 1, grants: [], actor }),
    ).toMatchObject({
      mode: 'inherit',
      version: 0,
      inheritedFrom: { id: null, name: '节点库' },
    });
    expect(business.updateEnterpriseKbNodeAccess).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ mode: 'inherit', version: 1 }),
    );
    for (const [code, status] of [
      ['STALE_VERSION', 409],
      ['INVALID_PRINCIPAL', 422],
    ] as const) {
      vi.mocked(business.updateEnterpriseKbNodeAccess).mockRejectedValueOnce(
        new business.EnterpriseKbError(code, 'sensitive SQL'),
      );
      expect(
        await json('PUT', path, { mode: 'custom', version: 0, grants: [], actor }, status),
      ).toEqual({
        error: { code, message: expect.not.stringContaining('sensitive') },
      });
    }
    const grants = [
      { principalId: 'member', principalType: 'user' as const, accessLevel: 'view' as const },
    ];
    const estimate = {
      total: 1,
      edit: 0,
      view: 1,
      lost: 2,
      downgraded: 0,
      pathOnly: [{ principalId: 'member', principalType: 'user' as const }],
    };
    vi.mocked(business.estimateEnterpriseKbNodeAccess).mockResolvedValue(estimate);
    for (const mode of ['custom', 'inherit']) {
      expect(await json('POST', path + '/estimate', { mode, grants })).toEqual(estimate);
      expect(business.estimateEnterpriseKbNodeAccess).toHaveBeenLastCalledWith(db, {
        knowledgeBaseId: kb,
        nodeId: node,
        ancestorIds: [],
        mode,
        grants,
      });
    }
    for (const body of [
      { mode: 'other', version: 0, grants: [], actor },
      { mode: 'custom', version: -1, grants: [], actor },
      { mode: 'custom', version: 0, grants: [] },
      { mode: 'custom', version: 0, grants: [{ ...grants[0], accessLevel: 'owner' }], actor },
    ])
      expect(await json('PUT', path, body, 400)).toMatchObject({
        error: { code: 'INVALID_REQUEST' },
      });
    expect(await json('POST', path + '/estimate', { grants }, 400)).toMatchObject({
      error: { code: 'INVALID_REQUEST' },
    });
  });

  it('marks only custom nodes in lists and passes node events through unchanged', async () => {
    const kb = await library();
    const custom = await document(kb, '单独设置');
    const inherited = await document(kb, '继承');
    vi.mocked(business.listEnterpriseKbNodePolicies).mockResolvedValue([
      { nodeId: custom, version: 1 },
    ]);
    expect((await json('GET', `/${kb}/items`)).items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: custom, customAccess: true }),
        expect.objectContaining({ id: inherited, customAccess: false }),
      ]),
    );
    const event = {
      id: 'node-event',
      action: 'node_access_updated' as const,
      actor: { ...actor, kind: 'admin' as const },
      createdAt: '2026-11-11T00:00:00.000Z',
      detail: {
        nodeId: custom,
        nodeKind: 'folder',
        nodeName: '单独设置',
        fromMode: 'inherit',
        toMode: 'custom',
        added: [],
        removed: [],
        changed: [],
      },
    };
    vi.mocked(business.listEnterpriseKbEvents).mockResolvedValue([event]);
    expect(await json('GET', `/${kb}/events`)).toEqual({ items: [event] });
    await json('PATCH', `/${kb}/items/${custom}`, { parentId: inherited, actor });
    expect((await json('GET', `/${kb}/items?parentId=${inherited}`)).items).toMatchObject([
      { id: custom, customAccess: true },
    ]);
  });

  it('keeps policies through trash/restore and cleans every descendant on purge in the deletion transaction', async () => {
    const kb = await library();
    const root = await document(kb, '目录');
    const child = await document(kb, '子目录', root);
    const page = await document(kb, '文稿', child, false);
    const attachment = await file(kb, child);
    const sibling = await document(kb, '保留');
    for (const method of ['DELETE', 'POST']) {
      const path = method === 'DELETE' ? `/${kb}/items/${root}` : `/${kb}/trash/${root}/restore`;
      expect((await request(method, path, { actor })).status).toBe(method === 'DELETE' ? 204 : 200);
    }
    expect(business.removeEnterpriseKbNodePolicies).not.toHaveBeenCalled();
    expect((await request('DELETE', `/${kb}/items/${root}`, { actor })).status).toBe(204);
    const before = await db.select().from(trashItems);
    vi.mocked(business.removeEnterpriseKbNodePolicies).mockRejectedValueOnce(
      new Error('policy cleanup failed'),
    );
    expect((await request('DELETE', `/${kb}/trash/${root}`, { actor })).status).toBe(500);
    expect(await db.select().from(trashItems)).toEqual(before);
    expect((await db.select().from(documents).where(eq(documents.id, page)))[0].isDeleted).toBe(
      true,
    );
    expect((await db.select().from(files).where(eq(files.id, attachment)))[0].isDeleted).toBe(true);
    expect((await request('DELETE', `/${kb}/trash/${root}`, { actor })).status).toBe(204);
    const [tx, params] = vi.mocked(business.removeEnterpriseKbNodePolicies).mock.lastCall!;
    expect(tx).not.toBe(db);
    expect(params.knowledgeBaseId).toBe(kb);
    expect(params.nodeIds.toSorted()).toEqual([root, child, page, attachment].toSorted());
    expect(await db.select().from(documents).where(eq(documents.id, page))).toEqual([]);
    expect(await db.select().from(files).where(eq(files.id, attachment))).toEqual([]);
    expect((await db.select().from(documents)).map((row) => row.id)).toEqual([sibling]);
  });
});

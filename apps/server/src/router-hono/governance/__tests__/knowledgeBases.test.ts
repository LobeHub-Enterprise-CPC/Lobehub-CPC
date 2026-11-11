import * as business from '@lobechat/business-knowledge';
import { eq } from 'drizzle-orm';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import * as nextRoute from '@/app/(backend)/api/governance/[[...route]]/route';
import { getTestDB } from '@/database/core/getTestDB';
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
  knowledgeBases,
  unstructuredChunks,
  users,
} from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';

const mocks = vi.hoisted(() => ({
  db: undefined as unknown,
  enabled: true,
  enterpriseIds: new Set<string>(),
  publish: vi.fn(),
  objects: new Set<string>(),
  admit: vi.fn(),
  storage: {
    createPreSignedUpload: vi.fn(async (key: string) => {
      mocks.objects.add(key);
      return { headers: {}, url: `https://storage.test/${key}` };
    }),
    createDownloadUrl: vi.fn(async (key: string) => `https://storage.test/download/${key}`),
    deleteFiles: vi.fn(),
    getFileMetadata: vi.fn(async (key: string) => {
      if (!mocks.objects.has(key)) throw Object.assign(new Error('missing'), { name: 'NotFound' });
      return { contentLength: 12, contentType: 'text/plain' };
    }),
  },
  uploaders: {} as Record<string, { id: string; kind: 'admin'; name: string }>,
}));
vi.mock('@/business/server/lambda-routers/file', () => ({ businessFileUploadCheck: mocks.admit }));
vi.mock('@/database/core/db-adaptor', () => ({ getServerDB: async () => mocks.db }));
vi.mock('@/envs/app', () => ({ appEnv: { COMMAND_GOVERNANCE_SERVICE_TOKEN: 'test-token' } }));
vi.mock('@/server/services/file/impls', () => ({ createFileServiceModule: () => mocks.storage }));
vi.mock('@/server/modules/ContentChunk', () => ({ ContentChunk: class {} }));
vi.mock('@/server/modules/Hatchet/directDelivery', () => ({
  getDirectDeliveryClient: () => ({ publishJSON: mocks.publish }),
}));
vi.mock('@/server/modules/Tenant/callbackUrl', () => ({
  buildTenantCallbackUrl: (path: string) => `https://tenant.test${path}`,
}));
vi.mock('@lobechat/business-knowledge', async (original) => ({
  ...(await original<typeof business>()),
  isEnterpriseKnowledgeEnabled: () => mocks.enabled,
  listEnterpriseKbIds: async (_db: unknown, ids?: string[]) =>
    [...mocks.enterpriseIds].filter((id) => !ids || ids.includes(id)),
  findEnterpriseKbMember: vi.fn(async (_db: unknown, by: { email?: string; id?: string }) => {
    const id =
      by.id ??
      (by.email === 'owner@test.dev'
        ? 'ekb-owner'
        : by.email === 'disabled@test.dev'
          ? 'ekb-disabled'
          : null);
    return id && ['ekb-owner', 'ekb-next', 'ekb-disabled'].includes(id)
      ? {
          id,
          name: id === 'ekb-owner' ? '张负责人' : id,
          email: id === 'ekb-owner' ? 'owner@test.dev' : null,
          disabled: id === 'ekb-disabled',
          departmentName: null,
        }
      : null;
  }),
  markEnterpriseKb: vi.fn(async (_db, p) => {
    mocks.enterpriseIds.add(p.knowledgeBaseId);
  }),
  unmarkEnterpriseKb: vi.fn(async (_db, p) => {
    mocks.enterpriseIds.delete(p.knowledgeBaseId);
  }),
  summarizeEnterpriseKbAccess: async (_db: unknown, ids: string[]) =>
    Object.fromEntries(ids.map((id) => [id, { departmentCount: 2, userCount: 1, everyone: true }])),
  getEnterpriseKbAccessState: vi.fn(async () => ({ version: 2, grants: [] })),
  updateEnterpriseKbAccess: vi.fn(async () => ({ version: 3, grants: [] })),
  estimateEnterpriseKbAccess: vi.fn(async () => ({
    total: 4,
    edit: 2,
    view: 2,
    lost: 1,
    downgraded: 1,
  })),
  getEnterpriseKbDirectory: vi.fn(async () => ({ departments: [], users: [] })),
  listEnterpriseKbEvents: vi.fn(async () => []),
  searchEnterpriseKbMembers: vi.fn(async () => []),
  recordEnterpriseKbTransfer: vi.fn(),
  recordEnterpriseKbItemUploaders: vi.fn(async (_db, items) => {
    for (const item of items) mocks.uploaders[item.itemId] = item.actor;
  }),
  getEnterpriseKbItemUploaders: async () => mocks.uploaders,
  removeEnterpriseKbItemUploaders: vi.fn(),
}));

const app = (await import('../index')).default;
let db: LobeChatDatabase;
const actor = { id: 'admin-1', name: '管理员' };
const prefix = '/api/governance/knowledge-bases';
const request = (method: string, path = '', data?: unknown, token: string | null = 'test-token') =>
  app.request(`${prefix}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      'content-type': 'application/json',
    },
    ...(data === undefined || method === 'GET' ? {} : { body: JSON.stringify(data) }),
  });
const json = async (method: string, path = '', data?: unknown, status = 200) => {
  const res = await request(method, path, data);
  const body = res.status === 204 ? null : await res.json();
  expect({ status: res.status, body }).toEqual({ status, body: expect.anything() });
  return body;
};
const error = async (method: string, path: string, data: unknown, code: string, status: number) => {
  const res = await request(method, path, data);
  expect(res.status).toBe(status);
  expect(await res.json()).toEqual({ error: { code, message: expect.any(String) } });
};
const create = async (name = '企业库') =>
  (await json('POST', '', { name, ownerEmail: 'owner@test.dev', actor }, 201)).id as string;
const folder = async (kb: string, name = '文件夹', parentId?: string) =>
  json('POST', `/${kb}/folders`, { name, parentId, actor }, 201);
const upload = async (kb: string, parentId?: string) => {
  const signed = await json('POST', `/${kb}/uploads/presign`, {
    name: 'sample.txt',
    size: 12,
    contentType: 'text/plain',
  });
  expect(signed).toEqual({
    uploadUrl: expect.stringContaining('https://storage.test/'),
    method: 'PUT',
    headers: {},
    key: expect.any(String),
  });
  return json(
    'POST',
    `/${kb}/files`,
    { key: signed.key, name: 'sample.txt', size: 12, contentType: 'text/plain', parentId, actor },
    201,
  );
};
const setTask = async (
  fileId: string,
  stage: 'chunkTaskId' | 'embeddingTaskId',
  status: string,
  taskError?: unknown,
) => {
  const [task] = await db
    .insert(asyncTasks)
    .values({ userId: 'ekb-owner', status, error: taskError })
    .returning();
  await db
    .update(files)
    .set({ [stage]: task.id })
    .where(eq(files.id, fileId));
  return task.id;
};
const allRoutes = [
  ['GET', ''],
  ['POST', ''],
  ['GET', '/members'],
  ['GET', '/directory'],
  ['GET', '/kb'],
  ['PATCH', '/kb'],
  ['DELETE', '/kb'],
  ['POST', '/kb/transfer'],
  ['GET', '/kb/access'],
  ['PUT', '/kb/access'],
  ['POST', '/kb/access/estimate'],
  ['GET', '/kb/events'],
  ['GET', '/kb/items'],
  ['POST', '/kb/uploads/presign'],
  ['POST', '/kb/files'],
  ['POST', '/kb/folders'],
  ['PATCH', '/kb/items/item'],
  ['DELETE', '/kb/items/item'],
  ['POST', '/kb/items/item/retry'],
  ['POST', '/kb/retry-failed'],
  ['POST', '/kb/reprocess'],
  ['GET', '/kb/items/item/download'],
  ['GET', '/kb/trash'],
  ['POST', '/kb/trash/item/restore'],
  ['DELETE', '/kb/trash/item'],
] as const;

beforeAll(async () => {
  db = await getTestDB();
  mocks.db = db;
}, 120000);
beforeEach(async () => {
  vi.clearAllMocks();
  mocks.enabled = true;
  mocks.enterpriseIds.clear();
  mocks.uploaders = {};
  mocks.objects.clear();
  mocks.admit.mockResolvedValue(undefined);
  mocks.publish.mockResolvedValue({});
  for (const id of ['ekb-owner', 'ekb-next', 'ekb-disabled']) {
    await db
      .insert(users)
      .values({
        id,
        fullName: id === 'ekb-owner' ? '张负责人' : id,
        email: id === 'ekb-owner' ? 'owner@test.dev' : `${id}@test.dev`,
      })
      .onConflictDoNothing();
  }
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const id of ['ekb-owner', 'ekb-next', 'ekb-disabled'])
    await db.delete(users).where(eq(users.id, id));
});

describe('enterprise knowledge governance contract', () => {
  it('exports every registered governance HTTP method through the Next route', async () => {
    const methods = new Set(
      app.routes.map((route) => route.method).filter((method) => method !== 'ALL'),
    );
    for (const method of methods)
      expect(Reflect.get(nextRoute, method), method).toBeTypeOf('function');
    const patch = Reflect.get(nextRoute, 'PATCH') as (request: Request) => Promise<Response>;
    const response = await patch(
      new Request(`https://governance.test${prefix}/missing`, { method: 'PATCH' }),
    );
    expect(response.status).toBe(401);
  });

  it('guards every endpoint with service-token auth and disabled capability', async () => {
    for (const [method, path] of allRoutes) {
      for (const token of [null, 'wrong'])
        expect((await request(method, path, undefined, token)).status, `${method} ${path}`).toBe(
          401,
        );
      mocks.enabled = false;
      await error(method, path, undefined, 'NOT_ENABLED', 501);
    }
  });

  it('applies native upload admission before issuing a presign', async () => {
    const kb = await create();
    mocks.admit.mockRejectedValueOnce(new Error('quota exceeded'));
    expect(
      (
        await request('POST', '/' + kb + '/uploads/presign', {
          name: 'sample.txt',
          size: 12,
          contentType: 'text/plain',
        })
      ).status,
    ).toBe(500);
    expect(mocks.storage.createPreSignedUpload).not.toHaveBeenCalled();
    expect(await db.select().from(fileUploads)).toEqual([]);
  });

  it('validates JSON, actor, fields and pagination before any writes', async () => {
    await error('POST', '', { name: 'x', ownerEmail: 'owner@test.dev' }, 'INVALID_REQUEST', 400);
    await error('GET', '?page=0', undefined, 'INVALID_REQUEST', 400);
    await error('GET', '?pageSize=1.5', undefined, 'INVALID_REQUEST', 400);
    const res = await app.request(prefix, {
      method: 'POST',
      headers: { authorization: 'Bearer test-token' },
      body: '{',
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('INVALID_REQUEST');
  });

  it('validates owner and duplicate names, creates in owner scope and marks atomically', async () => {
    await error(
      'POST',
      '',
      { name: '库', ownerEmail: 'missing@test.dev', actor },
      'OWNER_NOT_FOUND',
      422,
    );
    await error(
      'POST',
      '',
      { name: '库', ownerEmail: 'disabled@test.dev', actor },
      'OWNER_DISABLED',
      422,
    );
    const id = await create();
    const [row] = await db.select().from(knowledgeBases).where(eq(knowledgeBases.id, id));
    expect(row).toMatchObject({ userId: 'ekb-owner', workspaceId: null });
    expect(business.markEnterpriseKb).toHaveBeenCalledWith(expect.anything(), {
      actor: { ...actor, kind: 'admin' },
      knowledgeBaseId: id,
      name: '企业库',
    });
    await error(
      'POST',
      '',
      { name: '企业库', ownerEmail: 'owner@test.dev', actor },
      'NAME_EXISTS',
      409,
    );
    vi.mocked(business.markEnterpriseKb).mockRejectedValueOnce(new Error('policy write failed'));
    expect(
      (await request('POST', '', { name: '回滚库', ownerEmail: 'owner@test.dev', actor })).status,
    ).toBe(500);
    expect(await db.select().from(knowledgeBases).where(eq(knowledgeBases.name, '回滚库'))).toEqual(
      [],
    );
  });

  it('lists only enterprise libraries with summaries, owner search and accurate pagination', async () => {
    const a = await create('A');
    await create('B');
    await db.insert(knowledgeBases).values({ name: '个人库', userId: 'ekb-owner' });
    const file = await upload(a);
    await setTask(file.id, 'chunkTaskId', 'error');
    const result = await json('GET', '?q=张负责人&pageSize=1&page=2');
    expect(result.total).toBe(2);
    expect(result.items).toHaveLength(1);
    const item = await json('GET', `/${a}`);
    expect(item).toMatchObject({
      owner: { id: 'ekb-owner', disabled: false },
      fileCount: 1,
      processingCount: 0,
      failedCount: 1,
      access: { departmentCount: 2, userCount: 1, everyone: true },
    });
    expect((await json('GET', '?q=A')).total).toBe(1);
    expect((await json('GET', '?q=owner%40test.dev')).total).toBe(2);
    expect((await json('GET', '?q=%25')).total).toBe(0);
    const updated = await json('PATCH', `/${a}`, { name: 'A2', description: '说明', actor });
    expect(updated).toMatchObject({ name: 'A2', description: '说明' });
    await error('PATCH', `/${a}`, { name: 'B', actor }, 'NAME_EXISTS', 409);
  });

  it('registers uploads in owner scope, settles the reservation and queues the native parse workflow', async () => {
    const kb = await create();
    const f = await folder(kb);
    const item = await upload(kb, f.id);
    expect(item).toMatchObject({
      kind: 'file',
      parentId: f.id,
      status: 'pending',
      uploader: { ...actor, kind: 'admin' },
    });
    const [row] = await db.select().from(files).where(eq(files.id, item.id));
    const [link] = await db
      .select()
      .from(knowledgeBaseFiles)
      .where(eq(knowledgeBaseFiles.fileId, item.id));
    expect(row).toMatchObject({
      userId: 'ekb-owner',
      workspaceId: null,
      chunkTaskId: expect.any(String),
    });
    expect(link).toMatchObject({ userId: 'ekb-owner', knowledgeBaseId: kb, workspaceId: null });
    expect((await db.select().from(fileUploads))[0]).toMatchObject({
      fileId: item.id,
      status: 'settled',
    });
    expect(mocks.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({ userId: 'ekb-owner', fileId: item.id }),
        url: expect.stringContaining('/file/parse'),
      }),
    );
    expect(business.recordEnterpriseKbItemUploaders).toHaveBeenCalledWith(
      expect.anything(),
      expect.arrayContaining([
        { actor: { ...actor, kind: 'admin' }, itemId: item.id, knowledgeBaseId: kb },
      ]),
    );
    await error(
      'POST',
      `/${kb}/files`,
      { key: row.url, name: 'sample.txt', size: 12, contentType: 'text/plain', actor },
      'INVALID_REQUEST',
      400,
    );
    await error(
      'POST',
      `/${kb}/files`,
      { key: 'arbitrary/key', name: 'sample.txt', size: 12, contentType: 'text/plain', actor },
      'INVALID_REQUEST',
      400,
    );
  });

  it('returns hierarchy and breadcrumb, filters globally and folds safe processing states', async () => {
    const kb = await create();
    const f = await folder(kb);
    const file = await upload(kb, f.id);
    expect((await json('GET', `/${kb}/items`)).items.map((x: { id: string }) => x.id)).toEqual([
      f.id,
    ]);
    const nested = await json('GET', `/${kb}/items?parentId=${f.id}`);
    expect(nested.breadcrumb).toEqual([{ id: f.id, name: '文件夹' }]);
    expect(nested.items[0]).toMatchObject({ id: file.id, status: 'pending' });
    await setTask(file.id, 'chunkTaskId', 'processing');
    expect((await json('GET', `/${kb}/items?status=processing`)).items[0].status).toBe('parsing');
    await setTask(file.id, 'chunkTaskId', 'success');
    await setTask(file.id, 'embeddingTaskId', 'processing');
    expect((await json('GET', `/${kb}/items?q=sample`)).items[0].status).toBe('embedding');
    await setTask(file.id, 'embeddingTaskId', 'success');
    expect((await json('GET', `/${kb}/items?q=sample`)).items[0].status).toBe('success');
    await setTask(file.id, 'embeddingTaskId', 'error', {
      name: 'Unknown',
      message: 'SELECT secret FROM users\n at stack',
    });
    const failed = await json('GET', `/${kb}/items?status=failed`);
    expect(failed).toMatchObject({ total: 1, counts: { failed: 1, processing: 0 } });
    expect(failed.items[0]).toMatchObject({
      status: 'error',
      statusDetail: { stage: 'embedding', message: '文件向量化失败，请重试。', progress: null },
    });
  });

  it('renames, moves to root, rejects cycles and foreign IDs on every item operation', async () => {
    const kb = await create();
    const f = await folder(kb);
    const file = await upload(kb, f.id);
    const other = await create('另一个库');
    expect(
      await json('PATCH', `/${kb}/items/${file.id}`, { name: '改名.txt', parentId: null, actor }),
    ).toMatchObject({ name: '改名.txt', parentId: null });
    const sub = await folder(kb, '子目录', f.id);
    await error(
      'PATCH',
      `/${kb}/items/${f.id}`,
      { parentId: sub.id, actor },
      'INVALID_REQUEST',
      400,
    );
    for (const [method, suffix] of [
      ['PATCH', `/items/${file.id}`],
      ['DELETE', `/items/${file.id}`],
      ['POST', `/items/${file.id}/retry`],
      ['GET', `/items/${file.id}/download`],
      ['POST', `/trash/${file.id}/restore`],
      ['DELETE', `/trash/${file.id}`],
    ] as const) {
      await error(method, `/${other}${suffix}`, { actor, name: 'x' }, 'NOT_FOUND', 404);
    }
    await error('GET', `/${other}/items?parentId=${f.id}`, undefined, 'NOT_FOUND', 404);
    await error(
      'POST',
      `/${other}/folders`,
      { name: 'x', parentId: f.id, actor },
      'NOT_FOUND',
      404,
    );
    const [personal] = await db
      .insert(knowledgeBases)
      .values({ name: 'personal', userId: 'ekb-owner' })
      .returning();
    await error('GET', `/${personal.id}`, undefined, 'NOT_FOUND', 404);
  });

  it('trashes and restores files and folder subtrees, purges and preserves unrelated siblings', async () => {
    const kb = await create();
    const f = await folder(kb);
    const child = await upload(kb, f.id);
    const sibling = await folder(kb, '保留');
    expect((await request('DELETE', `/${kb}/items/${f.id}`, { actor })).status).toBe(204);
    const trash = await json('GET', `/${kb}/trash`);
    expect(trash.items.map((x: { id: string }) => x.id)).toContain(f.id);
    expect((await json('GET', `/${kb}/items`)).items.map((x: { id: string }) => x.id)).toEqual([
      sibling.id,
    ]);
    expect(await json('POST', `/${kb}/trash/${f.id}/restore`, { actor })).toMatchObject({
      id: f.id,
      kind: 'folder',
    });
    expect((await json('GET', `/${kb}/items?parentId=${f.id}`)).items[0].id).toBe(child.id);
    expect((await request('DELETE', `/${kb}/items/${child.id}`, { actor })).status).toBe(204);
    expect(await json('POST', `/${kb}/trash/${child.id}/restore`, { actor })).toMatchObject({
      id: child.id,
    });
    await request('DELETE', `/${kb}/items/${f.id}`, { actor });
    expect((await request('DELETE', `/${kb}/trash/${f.id}`, { actor })).status).toBe(204);
    expect(await db.select().from(files).where(eq(files.id, child.id))).toEqual([]);
    expect((await json('GET', `/${kb}/items`)).total).toBe(1);
  });

  it('retries only the failed stage, retries all failures, reprocesses and downloads', async () => {
    const kb = await create();
    const f = await upload(kb);
    await setTask(f.id, 'chunkTaskId', 'success');
    await setTask(f.id, 'embeddingTaskId', 'error');
    mocks.publish.mockClear();
    const retry = await json('POST', `/${kb}/items/${f.id}/retry`, { actor });
    expect(retry.status).toBe('embedding');
    expect(mocks.publish.mock.calls[0][0].url).toContain('/file/embed');
    await setTask(f.id, 'chunkTaskId', 'error');
    expect(await json('POST', `/${kb}/retry-failed`, { actor })).toEqual({ retried: 1 });
    expect(await json('POST', `/${kb}/reprocess`, { actor })).toEqual({ queued: 1 });
    expect(await json('GET', `/${kb}/items/${f.id}/download`)).toMatchObject({
      url: expect.stringContaining('https://storage.test/download/'),
    });
  });

  it('maps access errors and passes directory, estimate, members and events through the seam', async () => {
    const kb = await create();
    expect(await json('GET', `/${kb}/access`)).toEqual({ version: 2, grants: [] });
    for (const [code, status] of [
      ['STALE_VERSION', 409],
      ['INVALID_PRINCIPAL', 422],
    ] as const) {
      vi.mocked(business.updateEnterpriseKbAccess).mockRejectedValueOnce(
        new business.EnterpriseKbError(code, 'sensitive SQL'),
      );
      await error('PUT', `/${kb}/access`, { version: 1, grants: [], actor }, code, status);
    }
    expect(await json('PUT', `/${kb}/access`, { version: 2, grants: [], actor })).toEqual({
      version: 3,
      grants: [],
    });
    expect(await json('POST', `/${kb}/access/estimate`, { grants: [] })).toEqual({
      total: 4,
      edit: 2,
      view: 2,
      lost: 1,
      downgraded: 1,
    });
    expect(await json('GET', '/directory?keyword=张')).toEqual({ departments: [], users: [] });
    expect(await json('GET', '/members?keyword=张&limit=10')).toEqual({ items: [] });
    expect(await json('GET', `/${kb}/events?limit=5`)).toEqual({ items: [] });
    expect(business.getEnterpriseKbDirectory).toHaveBeenCalledWith(db, { keyword: '张' });
    expect(business.searchEnterpriseKbMembers).toHaveBeenCalledWith(db, {
      keyword: '张',
      limit: 10,
    });
    expect(business.listEnterpriseKbEvents).toHaveBeenCalledWith(db, {
      knowledgeBaseId: kb,
      limit: 5,
    });
  });

  it('transfers every owner-scoped row atomically, preserves parsed content, and rolls back on seam failure', async () => {
    const kb = await create();
    const f = await folder(kb);
    const item = await upload(kb, f.id);
    await db
      .update(asyncTasks)
      .set({ status: 'success' })
      .where(eq(asyncTasks.userId, 'ekb-owner'));
    await setTask(item.id, 'embeddingTaskId', 'success');
    const [doc] = await db
      .insert(documents)
      .values({
        userId: 'ekb-owner',
        fileId: item.id,
        knowledgeBaseId: kb,
        title: 'mirror',
        fileType: 'text/plain',
        sourceType: 'file',
        source: '',
        totalCharCount: 1,
        totalLineCount: 1,
      })
      .returning();
    const [c] = await db
      .insert(chunks)
      .values({ userId: 'ekb-owner', text: '已解析内容' })
      .returning();
    await db.insert(fileChunks).values({ userId: 'ekb-owner', fileId: item.id, chunkId: c.id });
    await db
      .insert(documentChunks)
      .values({ userId: 'ekb-owner', documentId: doc.id, chunkId: c.id });
    await db.insert(embeddings).values({ userId: 'ekb-owner', chunkId: c.id, model: 'existing' });
    await db
      .insert(unstructuredChunks)
      .values({ userId: 'ekb-owner', fileId: item.id, compositeId: c.id });
    await error(
      'POST',
      `/${kb}/transfer`,
      { toUserId: 'ekb-owner', keepPreviousOwnerEdit: false, actor },
      'TRANSFER_SAME_OWNER',
      422,
    );
    vi.mocked(business.recordEnterpriseKbTransfer).mockRejectedValueOnce(
      new Error('transfer event failed'),
    );
    expect(
      (
        await request('POST', `/${kb}/transfer`, {
          toUserId: 'ekb-next',
          keepPreviousOwnerEdit: true,
          actor,
        })
      ).status,
    ).toBe(500);
    for (const table of [
      knowledgeBases,
      knowledgeBaseFiles,
      files,
      documents,
      chunks,
      embeddings,
      fileChunks,
      documentChunks,
      asyncTasks,
      unstructuredChunks,
    ]) {
      expect(
        (await db.select({ userId: table.userId }).from(table)).every(
          (row) => row.userId === 'ekb-owner',
        ),
      ).toBe(true);
    }
    mocks.publish.mockClear();
    expect(
      await json('POST', `/${kb}/transfer`, {
        toUserId: 'ekb-next',
        keepPreviousOwnerEdit: true,
        actor,
      }),
    ).toMatchObject({ owner: { id: 'ekb-next' } });
    for (const table of [
      knowledgeBases,
      knowledgeBaseFiles,
      files,
      documents,
      chunks,
      embeddings,
      fileChunks,
      documentChunks,
      asyncTasks,
      unstructuredChunks,
      fileUploads,
    ]) {
      expect(
        (await db.select({ userId: table.userId }).from(table)).every(
          (row) => row.userId === 'ekb-next',
        ),
      ).toBe(true);
    }
    expect(business.recordEnterpriseKbTransfer).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        toUserId: 'ekb-next',
        fromUserId: 'ekb-owner',
        knowledgeBaseId: kb,
        keepPreviousOwnerEdit: true,
      }),
    );
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it('copies shared files and existing parsed graphs during transfer without changing the other library', async () => {
    const kb = await create();
    const other = await create('其他库');
    const f = await folder(kb);
    const item = await upload(kb, f.id);
    await setTask(item.id, 'chunkTaskId', 'success');
    await setTask(item.id, 'embeddingTaskId', 'success');
    await db
      .insert(knowledgeBaseFiles)
      .values({ knowledgeBaseId: other, fileId: item.id, userId: 'ekb-owner' });
    const [mirror] = await db
      .insert(documents)
      .values({
        userId: 'ekb-owner',
        fileId: item.id,
        parentId: f.id,
        fileType: 'custom/document',
        sourceType: 'file',
        source: '',
        title: 'parsed',
        content: '现有解析结果',
        totalCharCount: 6,
        totalLineCount: 1,
      })
      .returning();
    await db.insert(documentHistories).values({
      userId: 'ekb-owner',
      documentId: mirror.id,
      editorData: {},
      saveSource: 'manual',
      savedAt: new Date(),
    });
    const [c] = await db.insert(chunks).values({ userId: 'ekb-owner', text: '原切片' }).returning();
    await db.insert(fileChunks).values({ userId: 'ekb-owner', fileId: item.id, chunkId: c.id });
    await db
      .insert(documentChunks)
      .values({ userId: 'ekb-owner', documentId: mirror.id, chunkId: c.id });
    await db.insert(embeddings).values({ userId: 'ekb-owner', chunkId: c.id, model: '原模型' });
    mocks.publish.mockClear();
    await json('POST', '/' + kb + '/transfer', {
      toUserId: 'ekb-next',
      keepPreviousOwnerEdit: false,
      actor,
    });
    const [original] = await db.select().from(files).where(eq(files.id, item.id));
    expect(original.userId).toBe('ekb-owner');
    const [newLink] = await db
      .select()
      .from(knowledgeBaseFiles)
      .where(eq(knowledgeBaseFiles.knowledgeBaseId, kb));
    expect(newLink.fileId).not.toBe(item.id);
    const [copy] = await db.select().from(files).where(eq(files.id, newLink.fileId));
    expect(copy).toMatchObject({ userId: 'ekb-next', url: original.url, parentId: f.id });
    const [copiedDoc] = await db.select().from(documents).where(eq(documents.fileId, copy.id));
    expect(copiedDoc).toMatchObject({ userId: 'ekb-next', content: '现有解析结果' });
    expect(
      (
        await db
          .select()
          .from(documentHistories)
          .where(eq(documentHistories.documentId, copiedDoc.id))
      )[0].userId,
    ).toBe('ekb-next');
    const [copiedChunk] = await db.select().from(fileChunks).where(eq(fileChunks.fileId, copy.id));
    expect(copiedChunk.chunkId).not.toBe(c.id);
    expect(
      (await db.select().from(embeddings).where(eq(embeddings.chunkId, copiedChunk.chunkId!)))[0],
    ).toMatchObject({ userId: 'ekb-next', model: '原模型' });
    expect((await json('GET', '/' + kb + '/items?status=all&q=sample')).items[0]).toMatchObject({
      status: 'success',
      uploader: { ...actor, kind: 'admin' },
    });
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it('manages existing native documents, including file-backed notes, with document identity', async () => {
    const kb = await create();
    const [file] = await db
      .insert(files)
      .values({
        userId: 'ekb-owner',
        name: '文稿',
        fileType: 'custom/document',
        size: 0,
        url: 'internal://document',
      })
      .returning();
    await db
      .insert(knowledgeBaseFiles)
      .values({ userId: 'ekb-owner', knowledgeBaseId: kb, fileId: file.id });
    const [doc] = await db
      .insert(documents)
      .values({
        userId: 'ekb-owner',
        fileId: file.id,
        knowledgeBaseId: kb,
        title: '文稿',
        fileType: 'custom/document',
        sourceType: 'api',
        source: '',
        content: '文稿正文',
        totalCharCount: 4,
        totalLineCount: 1,
      })
      .returning();
    expect((await json('GET', '/' + kb + '/items')).items).toMatchObject([
      { id: doc.id, kind: 'document', status: 'none' },
    ]);
    const f = await folder(kb);
    expect(
      await json('PATCH', '/' + kb + '/items/' + doc.id, {
        name: '文稿改名',
        parentId: f.id,
        actor,
      }),
    ).toMatchObject({ id: doc.id, name: '文稿改名', parentId: f.id });
    expect((await json('GET', '/' + kb + '/items/' + doc.id + '/download')).url).toContain(
      'data:text/markdown',
    );
    expect((await request('DELETE', '/' + kb + '/items/' + doc.id, { actor })).status).toBe(204);
    expect(await json('POST', '/' + kb + '/trash/' + doc.id + '/restore', { actor })).toMatchObject(
      { id: doc.id },
    );
    await request('DELETE', '/' + kb + '/items/' + doc.id, { actor });
    expect((await request('DELETE', '/' + kb + '/trash/' + doc.id, { actor })).status).toBe(204);
    expect(await db.select().from(documents).where(eq(documents.id, doc.id))).toEqual([]);
    expect(await db.select().from(files).where(eq(files.id, file.id))).toEqual([]);
  });

  it('does not resurrect older trash when restoring a folder and refuses restore under a trashed parent', async () => {
    const kb = await create();
    const f = await folder(kb);
    const first = await upload(kb, f.id);
    await request('DELETE', '/' + kb + '/items/' + first.id, { actor });
    // Deliberately distinct deletion time, without a wall-clock sleep.
    await db
      .update(files)
      .set({ deletedAt: new Date('2020-01-01T00:00:00Z') })
      .where(eq(files.id, first.id));
    await request('DELETE', '/' + kb + '/items/' + f.id, { actor });
    await error('POST', '/' + kb + '/trash/' + first.id + '/restore', { actor }, 'NOT_FOUND', 404);
    await json('POST', '/' + kb + '/trash/' + f.id + '/restore', { actor });
    expect(
      (await json('GET', '/' + kb + '/trash')).items.map((x: { id: string }) => x.id),
    ).toContain(first.id);
  });

  it('keeps upload errors recoverable and sanitizes queue-trigger errors', async () => {
    const kb = await create();
    mocks.storage.createPreSignedUpload.mockRejectedValueOnce(new Error('storage unavailable'));
    expect(
      (
        await request('POST', '/' + kb + '/uploads/presign', {
          name: 'sample.txt',
          size: 12,
          contentType: 'text/plain',
        })
      ).status,
    ).toBe(500);
    expect(await db.select().from(fileUploads)).toEqual([]);
    const signed = await json('POST', '/' + kb + '/uploads/presign', {
      name: 'sample.txt',
      size: 12,
      contentType: 'text/plain',
    });
    mocks.storage.getFileMetadata.mockResolvedValueOnce({
      contentLength: 99,
      contentType: 'text/plain',
    });
    await error(
      'POST',
      '/' + kb + '/files',
      { key: signed.key, name: 'sample.txt', size: 12, contentType: 'text/plain', actor },
      'INVALID_REQUEST',
      400,
    );
    mocks.publish.mockRejectedValueOnce(new Error('SQL stack password=secret'));
    const registered = await json(
      'POST',
      '/' + kb + '/files',
      { key: signed.key, name: 'sample.txt', size: 12, contentType: 'text/plain', actor },
      201,
    );
    expect(registered).toMatchObject({
      status: 'error',
      statusDetail: { message: '处理任务没有成功启动，请重试。' },
    });
    expect(
      await json('POST', '/' + kb + '/items/' + registered.id + '/retry', { actor }),
    ).toMatchObject({ status: 'pending' });
  });

  it('enforces name uniqueness for simultaneous creates and rolls back deletion on policy failure', async () => {
    const responses = await Promise.all([
      request('POST', '', { name: '同名并发', ownerEmail: 'owner@test.dev', actor }),
      request('POST', '', { name: '同名并发', ownerEmail: 'owner@test.dev', actor }),
    ]);
    expect(responses.map((res) => res.status).sort()).toEqual([201, 409]);
    const kb = await create();
    const f = await folder(kb);
    const file = await upload(kb, f.id);
    vi.mocked(business.unmarkEnterpriseKb).mockRejectedValueOnce(new Error('unmark failed'));
    expect((await request('DELETE', '/' + kb, { actor })).status).toBe(500);
    expect((await json('GET', '/' + kb + '/items?parentId=' + f.id)).items[0].id).toBe(file.id);
    await error(
      'POST',
      '/' + kb + '/transfer',
      { actor, toUserId: 'missing', keepPreviousOwnerEdit: false },
      'OWNER_NOT_FOUND',
      422,
    );
    await error(
      'POST',
      '/' + kb + '/transfer',
      { actor, toUserId: 'ekb-disabled', keepPreviousOwnerEdit: false },
      'OWNER_DISABLED',
      422,
    );
  });

  it('does not change shared content or its trash state when deleting another library', async () => {
    const kb = await create();
    const other = await create('其他库');
    const file = await upload(kb);
    await db
      .insert(knowledgeBaseFiles)
      .values({ fileId: file.id, knowledgeBaseId: other, userId: 'ekb-owner' });
    await request('DELETE', '/' + kb + '/items/' + file.id, { actor });
    const [before] = await db.select().from(files).where(eq(files.id, file.id));
    expect((await request('DELETE', '/' + kb, { actor })).status).toBe(204);
    const [after] = await db.select().from(files).where(eq(files.id, file.id));
    expect(after).toEqual(before);
    expect(
      (
        await db
          .select()
          .from(knowledgeBaseFiles)
          .where(eq(knowledgeBaseFiles.knowledgeBaseId, other))
      )[0].fileId,
    ).toBe(file.id);
  });

  it('rejects registration under a stale owner when transfer commits during storage verification', async () => {
    const kb = await create();
    const signed = await json('POST', '/' + kb + '/uploads/presign', {
      name: 'sample.txt',
      size: 12,
      contentType: 'text/plain',
    });
    let release!: () => void;
    let observed!: () => void;
    const entered = new Promise<void>((resolve) => {
      observed = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    mocks.storage.getFileMetadata.mockImplementationOnce(async () => {
      observed();
      await waiting;
      return { contentLength: 12, contentType: 'text/plain' };
    });
    const pending = request('POST', '/' + kb + '/files', {
      key: signed.key,
      name: 'sample.txt',
      size: 12,
      contentType: 'text/plain',
      actor,
    });
    await entered;
    try {
      await json('POST', '/' + kb + '/transfer', {
        toUserId: 'ekb-next',
        keepPreviousOwnerEdit: false,
        actor,
      });
    } finally {
      release();
    }
    const response = await pending;
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe('NOT_FOUND');
    expect(
      await db.select().from(knowledgeBaseFiles).where(eq(knowledgeBaseFiles.knowledgeBaseId, kb)),
    ).toEqual([]);
  });

  it.each(['pending', 'parsing', 'embedding', 'awaiting-embedding'])(
    'returns TRANSFER_BUSY without changing ownership while a file is %s',
    async (stage) => {
      const kb = await create();
      const file = await upload(kb);
      if (stage === 'parsing') await setTask(file.id, 'chunkTaskId', 'processing');
      if (stage === 'embedding' || stage === 'awaiting-embedding') {
        await setTask(file.id, 'chunkTaskId', 'success');
        if (stage === 'embedding') await setTask(file.id, 'embeddingTaskId', 'processing');
      }
      const response = await request('POST', '/' + kb + '/transfer', {
        actor,
        toUserId: 'ekb-next',
        keepPreviousOwnerEdit: false,
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        error: { code: 'TRANSFER_BUSY', message: '库内还有文件在处理，处理完成后再转移' },
      });
      expect((await json('GET', '/' + kb)).owner.id).toBe('ekb-owner');
      expect((await db.select().from(files).where(eq(files.id, file.id)))[0].userId).toBe(
        'ekb-owner',
      );
      expect(business.recordEnterpriseKbTransfer).not.toHaveBeenCalled();
    },
  );

  it('deletes the library, all exclusive live and trashed content, and unmarks it', async () => {
    const kb = await create();
    const f = await folder(kb);
    const file = await upload(kb, f.id);
    await request('DELETE', `/${kb}/items/${file.id}`, { actor });
    expect((await request('DELETE', `/${kb}`, { actor })).status).toBe(204);
    expect(await db.select().from(knowledgeBases).where(eq(knowledgeBases.id, kb))).toEqual([]);
    expect(await db.select().from(files).where(eq(files.id, file.id))).toEqual([]);
    expect(await db.select().from(documents).where(eq(documents.id, f.id))).toEqual([]);
    expect(business.unmarkEnterpriseKb).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ knowledgeBaseId: kb, actor: { ...actor, kind: 'admin' } }),
    );
  });
});

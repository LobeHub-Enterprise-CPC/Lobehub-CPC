import { isEnterpriseKnowledgeEnabled } from '@lobechat/business-knowledge';
import type { Context, MiddlewareHandler } from 'hono';
import { z } from 'zod';

import { MAX_UPLOAD_FILE_SIZE } from '@/const/file';
import { getServerDB } from '@/database/core/db-adaptor';
import { EnterpriseKnowledgeAdminService } from '@/server/services/enterpriseKnowledgeAdmin';
import {
  KB_ADMIN_ERROR_STATUS,
  KbAdminError,
} from '@/server/services/enterpriseKnowledgeAdmin/errors';

const name = z.string().trim().min(1).max(255);
const actor = z.object({ id: z.string().min(1), name: z.string().min(1) });
const parentId = z.string().min(1).nullable().optional();
const grants = z.array(
  z.object({
    accessLevel: z.enum(['view', 'edit']),
    principalId: z.string().min(1),
    principalType: z.enum(['department', 'user']),
  }),
);
const pagination = (pageSize: number) =>
  z.object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(200).default(pageSize),
  });
const upload = z.object({
  contentType: z.string().min(1).max(255),
  name,
  size: z.number().int().min(0).max(MAX_UPLOAD_FILE_SIZE),
});

const messages = {
  INVALID_PRINCIPAL: '所选部门或成员不存在。',
  INVALID_REQUEST: '请求参数无效。',
  NAME_EXISTS: '企业知识库名称已存在。',
  NOT_ENABLED: '企业知识库未启用。',
  NOT_FOUND: '知识库或条目不存在。',
  OWNER_DISABLED: '成员已停用。',
  OWNER_NOT_FOUND: '未找到成员账号。',
  STALE_VERSION: '访问范围已被修改，请刷新后重试。',
  TRANSFER_BUSY: '库内还有文件在处理，处理完成后再转移',
  TRANSFER_SAME_OWNER: '接收人已经是当前负责人。',
} as const;

export const enterpriseKnowledgeEnabled: MiddlewareHandler = async (c, next) => {
  if (!isEnterpriseKnowledgeEnabled())
    return c.json({ error: { code: 'NOT_ENABLED', message: messages.NOT_ENABLED } }, 501);
  await next();
};

/** Only transport validation and safe error mapping live here; the DB remains tenant-scoped. */
const handle =
  <T extends z.ZodType>(
    schema: T,
    source: 'body' | 'query',
    run: (
      service: EnterpriseKnowledgeAdminService,
      c: Context,
      input: z.output<T>,
    ) => Promise<unknown>,
    status: 200 | 201 | 204 = 200,
  ) =>
  async (c: Context): Promise<Response> => {
    let input: z.output<T>;
    try {
      input = schema.parse(source === 'query' ? c.req.query() : await c.req.json());
    } catch {
      return c.json({ error: { code: 'INVALID_REQUEST', message: messages.INVALID_REQUEST } }, 400);
    }
    try {
      const service = new EnterpriseKnowledgeAdminService(await getServerDB());
      const result = await run(service, c, input);
      return status === 204 ? c.body(null, 204) : c.json(result, status);
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? error.code : undefined;
      if (typeof code === 'string' && code in messages) {
        const known = code as keyof typeof messages;
        return c.json(
          {
            error: {
              code: known,
              message:
                known === 'INVALID_REQUEST' && error instanceof KbAdminError
                  ? error.message
                  : messages[known],
            },
          },
          KB_ADMIN_ERROR_STATUS[known],
        );
      }
      if (code === 'NOT_ENTERPRISE')
        return c.json({ error: { code: 'NOT_FOUND', message: messages.NOT_FOUND } }, 404);
      console.error('[enterpriseKnowledgeAdmin] request failed:', error);
      return c.json(
        { error: { code: 'INTERNAL_ERROR', message: '知识库操作失败，请稍后重试。' } },
        500,
      );
    }
  };
const empty = z.object({});
const withActor = z.object({ actor });

export const listKnowledgeBases = handle(
  pagination(20).extend({ q: z.string().optional() }),
  'query',
  (s, _c, p) => s.libraries.list(p),
);
export const createKnowledgeBase = handle(
  z.object({ actor, description: z.string().optional(), name, ownerEmail: z.email() }),
  'body',
  (s, _c, p) => s.libraries.create(p),
  201,
);
export const getKnowledgeBase = handle(empty, 'query', (s, c) =>
  s.libraries.get(c.req.param('id')!),
);
export const updateKnowledgeBase = handle(
  z.object({ actor, description: z.string().nullable().optional(), name: name.optional() }),
  'body',
  (s, c, p) => s.libraries.update(c.req.param('id')!, p),
);
export const removeKnowledgeBase = handle(
  withActor,
  'body',
  (s, c, p) => s.libraries.remove(c.req.param('id')!, p.actor),
  204,
);
export const transferKnowledgeBase = handle(
  z.object({ actor, keepPreviousOwnerEdit: z.boolean(), toUserId: z.string().min(1) }),
  'body',
  (s, c, p) => s.libraries.transfer(c.req.param('id')!, p),
);
export const searchMembers = handle(
  z.object({
    keyword: z.string().default(''),
    limit: z.coerce.number().int().min(1).max(200).default(20),
  }),
  'query',
  (s, _c, p) => s.members(p),
);
export const directory = handle(z.object({ keyword: z.string().optional() }), 'query', (s, _c, p) =>
  s.directory(p),
);
export const getAccess = handle(empty, 'query', (s, c) => s.getAccess(c.req.param('id')!));
export const updateAccess = handle(
  z.object({ actor, grants, version: z.number().int().min(0) }),
  'body',
  (s, c, p) => s.updateAccess(c.req.param('id')!, p),
);
export const estimateAccess = handle(z.object({ grants }), 'body', (s, c, p) =>
  s.estimateAccess(c.req.param('id')!, p.grants),
);
export const listEvents = handle(
  z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }),
  'query',
  (s, c, p) => s.events(c.req.param('id')!, p.limit),
);
export const listItems = handle(
  pagination(50).extend({
    parentId: z.string().optional(),
    q: z.string().optional(),
    status: z.enum(['all', 'processing', 'failed']).default('all'),
  }),
  'query',
  (s, c, p) => s.content.list(c.req.param('id')!, p),
);
export const presignUpload = handle(upload, 'body', (s, c, p) =>
  s.content.presign(c.req.param('id')!, p),
);
export const registerFile = handle(
  upload.extend({
    actor,
    hash: z
      .string()
      .regex(/^[a-f\d]{64}$/i)
      .optional(),
    key: z.string().min(1),
    parentId,
  }),
  'body',
  (s, c, p) => s.content.register(c.req.param('id')!, p),
  201,
);
export const createFolder = handle(
  z.object({ actor, name, parentId }),
  'body',
  (s, c, p) => s.content.createFolder(c.req.param('id')!, p),
  201,
);
export const updateItem = handle(
  z.object({ actor, name: name.optional(), parentId }),
  'body',
  (s, c, p) => s.content.update(c.req.param('id')!, c.req.param('itemId')!, p),
);
export const removeItem = handle(
  withActor,
  'body',
  (s, c) => s.content.trash(c.req.param('id')!, c.req.param('itemId')!),
  204,
);
export const retryItem = handle(withActor, 'body', (s, c) =>
  s.content.retry(c.req.param('id')!, c.req.param('itemId')!),
);
export const retryFailed = handle(withActor, 'body', (s, c) =>
  s.content.retryFailed(c.req.param('id')!),
);
export const reprocess = handle(withActor, 'body', (s, c) =>
  s.content.reprocess(c.req.param('id')!),
);
export const downloadItem = handle(empty, 'query', (s, c) =>
  s.content.download(c.req.param('id')!, c.req.param('itemId')!),
);
export const listTrash = handle(pagination(50), 'query', (s, c, p) =>
  s.content.listTrash(c.req.param('id')!, p),
);
export const restoreItem = handle(withActor, 'body', (s, c) =>
  s.content.restore(c.req.param('id')!, c.req.param('itemId')!),
);
export const purgeItem = handle(
  withActor,
  'body',
  (s, c) => s.content.purge(c.req.param('id')!, c.req.param('itemId')!),
  204,
);

import type { LobeChatDatabase } from '@lobechat/database';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FileService, getFileProxyUrl } from '@/server/services/file';

import { queriesRouter } from './queries';

const mocks = vi.hoisted(() => ({ scopes: vi.fn(), full: vi.fn() }));
vi.mock('@/utils/env', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  isDev: true,
}));
vi.mock('@/server/modules/Tenant/callbackUrl', () => ({
  buildTenantPublicUrl: (path: string) => `https://app.test/orgs/acme${path}`,
}));
vi.mock('@/database/models/file', () => ({ FileModel: class {} }));
vi.mock('@/server/services/enterpriseKnowledge/contentClassification', () => ({
  classifyEnterpriseContentIds: mocks.scopes,
}));
vi.mock('@/server/services/enterpriseKnowledge/listAccess', () => ({
  queryEnterprisePage: (_ctx: unknown, query: (page: object) => unknown) => query({}),
}));
vi.mock('../_helpers/knowledgeBaseAccess', () => ({
  assertFileNotInRestrictedKnowledgeBase: vi.fn(),
}));
vi.mock('@/server/services/file/impls', () => ({
  createFileServiceModule: () => ({ getFullFileUrl: mocks.full }),
}));
vi.mock('./procedures', async () => {
  const { publicProcedure } = await import('@/libs/trpc/lambda');
  return {
    fileProcedure: publicProcedure.use(({ ctx, next }) => next({ ctx })),
    getKnowledgeItemStatusMap: async () =>
      new Map([
        ['enterprise', {}],
        ['personal', {}],
      ]),
  };
});

// Real URL resolver, model/storage I/O replaced at their boundaries. No live DB.
const files = ['enterprise', 'personal'].map((id) => ({
  id,
  name: `${id}.pdf`,
  fileType: 'application/pdf',
  url: `files/${id}.pdf`,
  userId: 'owner',
}));
const caller = () =>
  queriesRouter.createCaller({
    userId: 'owner',
    serverDB: {},
    enterpriseScope: { enterprise: false },
    enterpriseCallerId: 'owner',
    fileModel: {
      findById: async (id: string) => files.find((file) => file.id === id),
      query: async () => files,
      findKnowledgeBaseIds: async () => [],
    },
    fileService: new FileService({} as LobeChatDatabase, 'owner'),
  } as never);

describe('file browser query URLs in development', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.scopes.mockImplementation(
      async (_ctx, ids: string[]) => new Set(ids.filter((id) => id === 'enterprise')),
    );
    mocks.full.mockImplementation(async (url: string) => `https://storage.test/${url}`);
  });
  it.each(['findById', 'getFileItemById', 'getReadableUrl'] as const)(
    '%s returns enterprise proxy and keeps personal storage URL',
    async (method) => {
      expect((await caller()[method]({ id: 'enterprise' }))?.url).toBe(
        getFileProxyUrl('enterprise'),
      );
      expect((await caller()[method]({ id: 'personal' }))?.url).toBe(
        'https://storage.test/files/personal.pdf',
      );
    },
  );
  it('keeps mixed list URLs scoped to each file', async () => {
    const result = await caller().getFiles({ showFilesInKnowledgeBase: false });
    expect(result.map((file) => file.url)).toEqual([
      getFileProxyUrl('enterprise'),
      'https://storage.test/files/personal.pdf',
    ]);
  });
});

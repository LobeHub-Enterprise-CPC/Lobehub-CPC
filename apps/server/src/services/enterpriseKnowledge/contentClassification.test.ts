import type { LobeChatDatabase } from '@lobechat/database';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { documents } from '@/database/schemas';
import { FileService, getFileProxyUrl } from '@/server/services/file';

import { classifyEnterpriseContentIds } from './contentClassification';

const mocks = vi.hoisted(() => ({ libraries: vi.fn(), authorize: vi.fn(), storage: vi.fn() }));
vi.mock('@lobechat/business-knowledge', () => ({
  isEnterpriseKnowledgeEnabled: () => true,
  listEnterpriseKbIds: mocks.libraries,
  resolveEnterpriseKbAccess: mocks.authorize,
}));
vi.mock('@/database/models/file', () => ({ FileModel: class {} }));
vi.mock('@/server/services/file/impls', () => ({
  createFileServiceModule: () => ({ getFullFileUrl: mocks.storage }),
}));
vi.mock('@/server/modules/Tenant/callbackUrl', () => ({
  buildTenantPublicUrl: (path: string) => `https://app.test${path}`,
}));
vi.mock('@/utils/env', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  isDev: true,
}));

const database = (size: number) => {
  const pages = Array.from({ length: size }, (_, i) => ({
    id: `docs_${i}`,
    fileId: `file-${i}`,
    knowledgeBaseId: null,
    userId: 'owner',
    isDeleted: false,
  }));
  const files = pages.map((page) => ({
    id: page.fileId,
    knowledgeBaseId: 'enterprise',
    userId: 'owner',
    isDeleted: false,
  }));
  const select = vi.fn(() => ({
    from: (table: unknown) => {
      const query = {
        leftJoin: () => query,
        where: async () => (table === documents ? pages : files),
      };
      return query;
    },
  }));
  return { db: { select } as unknown as LobeChatDatabase, select, pages, files };
};

describe('enterprise content classification without authorization', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.libraries.mockResolvedValue(['enterprise']);
    mocks.authorize.mockRejectedValue(new Error('NOT_FOUND: caller denied'));
  });
  afterEach(() => vi.restoreAllMocks());
  it.each([1, 100])(
    'classifies %i document/backing-file pairs with a fixed query count',
    async (size) => {
      const { db, select, pages, files } = database(size);
      const ids = [...pages.map((page) => page.id), ...files.map((file) => file.id)];
      expect(await classifyEnterpriseContentIds({ serverDB: db }, ids)).toEqual(new Set(ids));
      expect(select).toHaveBeenCalledTimes(2);
      expect(mocks.libraries).toHaveBeenCalledTimes(1);
      expect(mocks.authorize).not.toHaveBeenCalled();
    },
  );
  it('fails a broken classification to proxy addresses without failing the response', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const db = {
      select: () => {
        throw new Error('classification database unavailable');
      },
    } as unknown as LobeChatDatabase;
    const files = [
      { id: 'a', url: 'files/a.pdf' },
      { id: 'b', url: 'files/b.pdf' },
    ];
    expect(await new FileService(db, 'viewer').getFileBrowserUrls(files)).toEqual(
      files.map((file) => getFileProxyUrl(file.id)),
    );
    expect(mocks.storage).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalled();
  });
});

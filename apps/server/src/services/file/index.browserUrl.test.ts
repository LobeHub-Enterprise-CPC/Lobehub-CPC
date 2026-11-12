import type { LobeChatDatabase } from '@lobechat/database';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FileService, getFileProxyUrl } from './index';

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
vi.mock('./impls', () => ({ createFileServiceModule: () => ({ getFullFileUrl: mocks.full }) }));

describe('browser file URL in development', () => {
  const service = () => new FileService({} as LobeChatDatabase, 'owner');
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.scopes.mockResolvedValue(new Set());
    mocks.full.mockResolvedValue('https://storage.test/signed');
  });
  it.each([{}, { readable: true }])(
    'returns an authenticated proxy for enterprise bytes (%j)',
    async (options) => {
      mocks.scopes.mockResolvedValue(new Set(['enterprise']));
      expect(
        await service().getFileBrowserUrl({ id: 'enterprise', url: 'files/a.pdf' }, options),
      ).toBe(getFileProxyUrl('enterprise'));
      expect(mocks.full).not.toHaveBeenCalled();
    },
  );
  it('uses the backing file id of a derived document', async () => {
    mocks.scopes.mockResolvedValue(new Set(['file-1']));
    expect(
      await service().getFileBrowserUrl({ id: 'docs_1', fileId: 'file-1', url: 'files/a.pdf' }),
    ).toBe(getFileProxyUrl('file-1'));
  });
  it.each([{}, { readable: true }])('preserves ordinary development URLs (%j)', async (options) => {
    expect(await service().getFileBrowserUrl({ id: 'personal', url: 'files/a.pdf' }, options)).toBe(
      'https://storage.test/signed',
    );
  });
  it('leaves the model URL method on its existing storage path', async () => {
    expect(await service().getFileAccessUrl({ id: 'enterprise', url: 'files/a.pdf' })).toBe(
      'https://storage.test/signed',
    );
    expect(mocks.scopes).not.toHaveBeenCalled();
  });
});

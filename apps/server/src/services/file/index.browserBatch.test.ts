import type { LobeChatDatabase } from '@lobechat/database';
import type { UIChatMessage } from '@lobechat/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveMessageFileUrlsInBatch } from '@/server/services/message/resolveMessageFileUrls';

import { FileService, getFileProxyUrl } from './index';

const mocks = vi.hoisted(() => ({ classify: vi.fn(), authorize: vi.fn(), full: vi.fn() }));
vi.mock('@/utils/env', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  isDev: true,
}));
vi.mock('@/server/modules/Tenant/callbackUrl', () => ({
  buildTenantPublicUrl: (path: string) => `https://app.test${path}`,
}));
vi.mock('@/database/models/file', () => ({ FileModel: class {} }));
vi.mock('@/server/services/enterpriseKnowledge/contentAccess', () => ({
  resolveEnterpriseContentScopes: mocks.authorize,
}));
vi.mock('@/server/services/enterpriseKnowledge/contentClassification', () => ({
  classifyEnterpriseContentIds: mocks.classify,
}));
vi.mock('./impls', () => ({ createFileServiceModule: () => ({ getFullFileUrl: mocks.full }) }));

describe('browser URL batch classification', () => {
  const service = () => new FileService({} as LobeChatDatabase, 'viewer');
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.classify.mockResolvedValue(new Set(['enterprise']));
    mocks.authorize.mockRejectedValue(new Error('NOT_FOUND: no access'));
    mocks.full.mockImplementation(async (url) => `https://storage.test/${url}`);
  });
  afterEach(() => vi.restoreAllMocks());
  it('resolves 100 historical attachments with one classification despite a denied enterprise item', async () => {
    const items = Array.from({ length: 100 }, (_, index) => ({
      id: index ? `personal-${index}` : 'enterprise',
      url: `files/${index}.pdf`,
    }));
    const urls = await service().getFileBrowserUrls(items);
    expect(urls[0]).toBe(getFileProxyUrl('enterprise'));
    expect(urls[99]).toBe('https://storage.test/files/99.pdf');
    expect(mocks.classify).toHaveBeenCalledTimes(1);
    expect(mocks.authorize).not.toHaveBeenCalled();
  });
  it('returns an entire historical message tree with one classification', async () => {
    const messages = Array.from({ length: 20 }, (_, index) => ({
      id: 'm' + index,
      role: 'user',
      imageList: [{ id: 'enterprise', url: 'files/secret.png' }],
      members: [
        {
          id: 'child' + index,
          role: 'user',
          imageList: [{ id: 'personal', url: 'files/personal.png' }],
        },
      ],
    })) as UIChatMessage[];
    const result = await resolveMessageFileUrlsInBatch(messages, (files) =>
      service().getFileBrowserUrls(files),
    );
    expect(result).toHaveLength(20);
    expect(result[0].imageList![0].url).toBe(getFileProxyUrl('enterprise'));
    expect(result[0].members![0].imageList![0].url).toBe('https://storage.test/files/personal.png');
    expect(mocks.classify).toHaveBeenCalledTimes(1);
    expect(mocks.authorize).not.toHaveBeenCalled();
  });
  it('uses already classified enterprise items without another query', async () => {
    const urls = await service().getFileBrowserUrls([
      { id: 'enterprise', url: 'a.pdf', enterpriseAccess: { level: 'view', custom: false } },
    ]);
    expect(urls).toEqual([getFileProxyUrl('enterprise')]);
    expect(mocks.classify).not.toHaveBeenCalled();
  });
});

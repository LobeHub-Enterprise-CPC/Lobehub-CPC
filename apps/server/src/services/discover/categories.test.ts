// @vitest-environment node
import { MarketAPIError } from '@lobehub/market-sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { clearAssetCategoryCache, getAssetCategories } from './categories';
import type { DiscoverService } from './index';

const { scope } = vi.hoisted(() => ({ scope: { current: undefined as object | undefined } }));

vi.mock('@lobechat/database/tenant', () => ({ currentTenantScope: () => scope.current }));
vi.mock('@/locales/resources', () => ({ normalizeLocale: (locale?: string) => locale || 'en-US' }));

const programming = {
  count: 3,
  description: '',
  icon: 'lucide:code',
  identifier: 'programming',
  localizations: {},
  name: 'Programming',
  sortOrder: 0,
};

const list = vi.fn();
const service = { market: { categories: { list } } } as unknown as DiscoverService;

describe('getAssetCategories', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    clearAssetCategoryCache();
    scope.current = undefined;
  });

  it('lists the categories of one asset type in the normalized locale', async () => {
    list.mockResolvedValue([programming]);

    await expect(
      getAssetCategories(service, { assetType: 'agent', locale: 'zh-CN' }),
    ).resolves.toEqual([programming]);
    expect(list).toHaveBeenCalledWith('agent', 'zh-CN');
  });

  it('serves a repeated read from the cache, per asset type and locale', async () => {
    list.mockResolvedValue([programming]);

    await getAssetCategories(service, { assetType: 'agent', locale: 'en-US' });
    await getAssetCategories(service, { assetType: 'agent', locale: 'en-US' });
    expect(list).toHaveBeenCalledTimes(1);

    await getAssetCategories(service, { assetType: 'agent', locale: 'zh-CN' });
    await getAssetCategories(service, { assetType: 'skill', locale: 'en-US' });
    expect(list).toHaveBeenCalledTimes(3);
  });

  it('reads through on every call inside a tenant scope', async () => {
    scope.current = { tenantId: 'tenant-a' };
    list.mockResolvedValue([programming]);

    await getAssetCategories(service, { assetType: 'mcp' });
    await getAssetCategories(service, { assetType: 'mcp' });

    expect(list).toHaveBeenCalledTimes(2);
  });

  it.each([new MarketAPIError(404, 'Not Found'), new MarketAPIError(501, 'Not Implemented')])(
    'answers [] when Market has no category directory: %s',
    async (error) => {
      list.mockRejectedValueOnce(error);

      await expect(getAssetCategories(service, { assetType: 'skill' })).resolves.toEqual([]);

      // The fallback is not remembered: the next read asks Market again.
      list.mockResolvedValueOnce([programming]);
      await expect(getAssetCategories(service, { assetType: 'skill' })).resolves.toEqual([
        programming,
      ]);
    },
  );

  it.each([
    new MarketAPIError(400, 'Bad Request', { error: { code: 'NOT_FOUND', message: 'Missing' } }),
    new MarketAPIError(403, 'Forbidden'),
    new MarketAPIError(500, 'Internal Server Error'),
    new MarketAPIError(503, 'Service Unavailable'),
    new Error('Network unavailable'),
  ])('rethrows any other failure without caching it: %s', async (error) => {
    list.mockRejectedValueOnce(error);

    await expect(getAssetCategories(service, { assetType: 'agent' })).rejects.toBe(error);

    list.mockResolvedValueOnce([programming]);
    await expect(getAssetCategories(service, { assetType: 'agent' })).resolves.toEqual([
      programming,
    ]);
  });
});

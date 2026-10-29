import { currentTenantScope } from '@lobechat/database/tenant';
import type { AssetCategoryItem, AssetCategoryType } from '@lobechat/types';
import { getMarketErrorKind, MarketAPIError } from '@lobehub/market-sdk';
import { LRUCache } from 'lru-cache';

import { normalizeLocale } from '@/locales/resources';

import type { DiscoverService } from './index';
import { log } from './utils';

/** Same freshness as the other discover category reads (`getMcpCategories`). */
const CATEGORY_CACHE_TTL_MS = 3600 * 1000;

/**
 * Keyed by asset type and normalized locale, both closed sets, so the bound is
 * never reached in practice.
 *
 * Only reads outside a tenant scope are cached, the same rule `marketFetchCache`
 * applies: inside a tenant the answer belongs to that tenant's Market instance,
 * whose administrators expect a category edit to show up on the next read.
 */
const categoryCache = new LRUCache<string, AssetCategoryItem[]>({
  max: 100,
  ttl: CATEGORY_CACHE_TTL_MS,
});

/**
 * A Market deployment that predates the category directory answers 404 (no such
 * route) or 501. The discover pages then keep their built-in category lists. A
 * 501 shares the `unavailable` kind with real outages, so it is told apart by
 * its status.
 */
const isCategoryDirectoryUnavailable = (error: unknown) => {
  const kind = getMarketErrorKind(error);
  return (
    kind === 'not_found' ||
    (kind === 'unavailable' && error instanceof MarketAPIError && error.status === 501)
  );
};

export const getAssetCategories = async (
  service: DiscoverService,
  params: { assetType: AssetCategoryType; locale?: string },
): Promise<AssetCategoryItem[]> => {
  const locale = normalizeLocale(params.locale);
  const cacheKey = `${params.assetType}:${locale}`;
  const cacheable = !currentTenantScope();

  if (cacheable) {
    const cached = categoryCache.get(cacheKey);
    if (cached) return cached;
  }

  let categories: AssetCategoryItem[];
  try {
    categories = await service.market.categories.list(params.assetType, locale);
  } catch (error) {
    if (isCategoryDirectoryUnavailable(error)) {
      log('getAssetCategories: Market has no category directory (%s)', params.assetType);
      // Not cached: once Market is upgraded the next read picks the directory up.
      return [];
    }
    throw error;
  }

  log('getAssetCategories: %d %s categories', categories.length, params.assetType);
  if (cacheable) categoryCache.set(cacheKey, categories);
  return categories;
};

/** Test seam: forget every cached directory. */
export const clearAssetCategoryCache = () => categoryCache.clear();

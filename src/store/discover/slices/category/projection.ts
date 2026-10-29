import { defineReplica, stableQueryKey } from '@/libs/replica';
import { discoverService } from '@/services/discover';
import type { AssetCategoryItem, AssetCategoryType } from '@/types/discover';

/** One category directory read: the asset type in the current UI language. */
export interface AssetCategoriesParams {
  assetType: AssetCategoryType;
  /** Market localizes `name` server-side, so a language switch is a new entry. */
  locale?: string;
}

/** Entry key of one category directory (`assetType` · `locale`). */
export const assetCategoriesQueryKey = (params: AssetCategoriesParams): string =>
  stableQueryKey(params);

/**
 * The categories Market has configured for one asset type
 * (`assetCategoriesMap[queryKey]`). Read by the sidebar, detail headers and
 * every card of a community list, and changed only by an administrator, so
 * localStorage keeps the first frame on the configured labels instead of
 * flashing the built-in ones.
 */
export const assetCategoriesResource = defineReplica<AssetCategoriesParams, AssetCategoryItem[]>({
  fetcher: (params) => discoverService.getAssetCategories(params),
  key: assetCategoriesQueryKey,
  name: 'assetCategories',
  storage: 'localStorage',
  version: 1,
});

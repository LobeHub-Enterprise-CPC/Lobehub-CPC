import type { AssetCategoryItem } from '@/types/discover';

import type { DiscoverStore } from '../store';

/**
 * Readers of the Market category directories. `undefined` means the directory
 * has not been read yet (or the read failed); `[]` means Market has none.
 */
const assetCategories =
  (queryKey?: string) =>
  (s: DiscoverStore): AssetCategoryItem[] | undefined =>
    queryKey ? s.assetCategoriesMap[queryKey] : undefined;

export const categorySelectors = {
  assetCategories,
};

import { useMemo } from 'react';

import { useDiscoverStore } from '@/store/discover';
import { categorySelectors } from '@/store/discover/selectors';
import type { AssetCategoryType } from '@/types/discover';

import { type CategoryCount, type DiscoverCategoryItem, mergeCategories } from './mergeCategories';

export interface UseDiscoverCategoriesOptions {
  /** Query-aware counts (the current search term), merged by identifier. */
  counts?: CategoryCount[];
  /** A search term is active, so only `counts` know how many assets match. */
  searching?: boolean;
}

/**
 * The categories of one community list: the pseudo entries of `local`, then the
 * categories Market has configured for `assetType`. Falls back to `local` as a
 * whole until Market answers, when it fails, or when it has none.
 *
 * `local` must be referentially stable (memoize it on `t`).
 */
export const useDiscoverCategories = (
  assetType: AssetCategoryType,
  local: DiscoverCategoryItem[],
  { counts, searching = false }: UseDiscoverCategoriesOptions = {},
): DiscoverCategoryItem[] => {
  const useFetchAssetCategories = useDiscoverStore((s) => s.useFetchAssetCategories);
  const { queryKey } = useFetchAssetCategories(assetType);
  const remote = useDiscoverStore(categorySelectors.assetCategories(queryKey));

  return useMemo(
    () => mergeCategories({ counts, local, remote, searching }),
    [counts, local, remote, searching],
  );
};

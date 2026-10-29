import { createReplicaSlice, recordLens, type ReplicaSyncResult } from '@/libs/replica';
import type { DiscoverStore } from '@/store/discover';
import { globalHelpers } from '@/store/global/helpers';
import type { StoreSetter } from '@/store/types';
import type { AssetCategoryItem, AssetCategoryType } from '@/types/discover';
import { setNamespace } from '@/utils/storeDebug';

import {
  type AssetCategoriesParams,
  assetCategoriesQueryKey,
  assetCategoriesResource,
} from './projection';

const n = setNamespace('discover/category');

export interface AssetCategoriesSyncResult extends ReplicaSyncResult {
  /** Read the value with `categorySelectors.assetCategories(queryKey)`. */
  queryKey: string;
}

type Setter = StoreSetter<DiscoverStore>;

export const createCategorySlice = (set: Setter, get: () => DiscoverStore, _api?: unknown) =>
  new CategoryActionImpl(set, get, _api);

export class CategoryActionImpl {
  readonly #categories;

  constructor(set: Setter, get: () => DiscoverStore, _api?: unknown) {
    void _api;
    this.#categories = createReplicaSlice(assetCategoriesResource, {
      actionPrefix: n('assetCategories'),
      get,
      set,
      stateKey: 'assetCategoriesReplica',
      view: recordLens<DiscoverStore, AssetCategoryItem[]>('assetCategoriesMap'),
    });
  }

  /**
   * The categories Market has configured for one asset type, in the current UI
   * language. An administrator's edit is picked up on the next mount; a window
   * focus does not refetch them.
   */
  useFetchAssetCategories = (assetType: AssetCategoryType): AssetCategoriesSyncResult => {
    const params: AssetCategoriesParams = {
      assetType,
      locale: globalHelpers.getCurrentLanguage(),
    };
    const sync = this.#categories.useSync(params, { revalidateOnFocus: false });
    return { ...sync, queryKey: assetCategoriesQueryKey(params) };
  };
}

export type CategoryAction = Pick<CategoryActionImpl, keyof CategoryActionImpl>;

import { createReplicaState, type ReplicaState } from '@/libs/replica';
import type { AssetCategoryItem } from '@/types/discover';

/** Replica view of the Market category directories, beside its bookkeeping slot. */
export interface CategorySliceState {
  /** Category directory per asset type and locale (`assetCategoriesQueryKey`). */
  assetCategoriesMap: Record<string, AssetCategoryItem[]>;
  /** Replica bookkeeping of `assetCategoriesMap`. */
  assetCategoriesReplica: ReplicaState<AssetCategoryItem[]>;
}

export const initialCategorySliceState: CategorySliceState = {
  assetCategoriesMap: {},
  assetCategoriesReplica: createReplicaState(),
};

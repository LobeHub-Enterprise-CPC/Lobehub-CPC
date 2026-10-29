import type {
  AssetCategoryItem,
  AssetCategoryType,
  CategoryLucideIconName,
} from '@lobehub/market-types';

/**
 * Categories configured in Market for one asset type (`GET /v1/categories`):
 * the stable `identifier` an asset's `category` holds, a `name` already
 * localized for the requested locale, an icon (`null`, an HTTP(S) image URL or
 * `lucide:<name>`), the display order (`sortOrder`) and the public asset count.
 *
 * `discover` / `all` are front-end entries and never come from Market.
 */
export type { AssetCategoryItem, AssetCategoryType, CategoryLucideIconName };

/** The front-end-only entries every category list keeps locally. */
export const DISCOVER_PSEUDO_CATEGORY_KEYS: readonly string[] = ['discover', 'all'];

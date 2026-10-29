import type { LucideIcon } from 'lucide-react';

import { type AssetCategoryItem, DISCOVER_PSEUDO_CATEGORY_KEYS } from '@/types/discover';

import { resolveCategoryIcon } from './categoryIcon';

/** One entry of a community category list, whatever its source. */
export interface DiscoverCategoryItem {
  /** Assets filed under it; for `all`, the sum of the others. Unknown counts stay undefined. */
  count?: number;
  /** Configured in Market (its order and names), rather than bundled. */
  fromMarket?: boolean;
  icon: LucideIcon;
  /** The asset `category` value (Market `identifier`), or a pseudo key (`discover` / `all`). */
  key: string;
  label: string;
  /** Longer description, shown as the entry's tooltip. */
  title?: string;
}

export interface CategoryCount {
  category: string;
  count?: number;
}

export interface MergeCategoriesParams {
  /**
   * Counts from the query-aware count endpoints, merged by identifier. Used for
   * every entry of the built-in list, and for the Market entries while searching.
   */
  counts?: CategoryCount[];
  /** The built-in list: the pseudo entries first, then the bundled categories. */
  local: DiscoverCategoryItem[];
  /** Market's directory; `undefined` while unread or after a failed read. */
  remote?: AssetCategoryItem[];
  /** A search term is active: Market's own counts ignore it. */
  searching?: boolean;
}

const isPseudo = (key: string) => DISCOVER_PSEUDO_CATEGORY_KEYS.includes(key);

const withAllCount = (items: DiscoverCategoryItem[]): DiscoverCategoryItem[] => {
  const known = items.filter((item) => !isPseudo(item.key) && item.count !== undefined);
  if (known.length === 0) return items;

  const total = known.reduce((sum, item) => sum + (item.count ?? 0), 0);
  return items.map((item) => (item.key === 'all' ? { ...item, count: total } : item));
};

/**
 * The category list a community page shows: the local pseudo entries followed by
 * the categories Market has configured, in its display order and with the names
 * it localized. Without a Market directory (unread, failed, or empty because the
 * deployment has none) the built-in list stays.
 */
export const mergeCategories = ({
  counts,
  local,
  remote,
  searching = false,
}: MergeCategoriesParams): DiscoverCategoryItem[] => {
  const countOf = (key: string) => counts?.find((item) => item.category === key)?.count;

  if (!remote || remote.length === 0) {
    return withAllCount(
      local.map((item) => (isPseudo(item.key) ? item : { ...item, count: countOf(item.key) })),
    );
  }

  const configured = remote
    .filter((category) => !isPseudo(category.identifier))
    .toSorted((a, b) => a.sortOrder - b.sortOrder || a.identifier.localeCompare(b.identifier))
    .map((category): DiscoverCategoryItem => ({
      count: searching ? countOf(category.identifier) : category.count,
      fromMarket: true,
      icon: resolveCategoryIcon(category.icon),
      key: category.identifier,
      label: category.name || category.identifier,
      title: category.description || undefined,
    }));

  return withAllCount([...local.filter((item) => isPseudo(item.key)), ...configured]);
};

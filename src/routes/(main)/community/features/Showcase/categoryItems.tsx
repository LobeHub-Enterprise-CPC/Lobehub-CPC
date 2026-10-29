import { Icon, type ListItemType } from '@lobehub/ui';

import { brandIcon } from '@/components/BrandIcon';
import type { DiscoverCategoryItem } from '@/features/DiscoverCategory/mergeCategories';
import WorkspaceLink from '@/features/Workspace/WorkspaceLink';

interface ShowcaseCategoryOptions {
  /** `category` keys the showcase drops, e.g. the recommendation-only "discover". */
  exclude?: string[];
  genUrl: (key: any) => string;
  /** Hide categories nothing is filed under (the "all" entry always stays). */
  hideEmpty?: boolean;
  kind: 'agent' | 'mcp' | 'skill';
  /**
   * Category keys in display order after "all"; keys not listed follow in their
   * own order. Applies to the bundled list only: a list configured in Market
   * keeps Market's order.
   */
  order?: string[];
}

/**
 * Category entries for the showcase market's panel: the deployment's icon for
 * each category, and the count as plain text that the panel reveals for the
 * selected and hovered entry only.
 */
export const buildShowcaseCategoryItems = (
  cates: DiscoverCategoryItem[],
  { exclude = [], genUrl, hideEmpty, kind, order: bundledOrder = [] }: ShowcaseCategoryOptions,
): ListItemType[] => {
  const order = cates.some((item) => item.fromMarket) ? [] : bundledOrder;
  const rank = (key: string) => {
    if (key === 'all') return -1;
    const index = order.indexOf(key);
    return index === -1 ? order.length : index;
  };

  return cates
    .filter((item) => !exclude.includes(item.key))
    .map((item, index) => ({ index, item }))
    .sort((a, b) => rank(a.item.key) - rank(b.item.key) || a.index - b.index)
    .map(({ item }) => item)
    .map((item) => ({ count: item.count ?? 0, item }))
    .filter(({ count, item }) => !hideEmpty || item.key === 'all' || count > 0)
    .map(({ count, item }) => ({
      extra: count > 0 ? <span data-category-count>{count.toLocaleString()}</span> : undefined,
      icon: <Icon icon={brandIcon(`category.${kind}.${item.key}`, item.icon)} size={16} />,
      key: item.key,
      label: <WorkspaceLink to={genUrl(item.key)}>{item.label}</WorkspaceLink>,
    }));
};

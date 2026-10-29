import {
  BriefcaseIcon,
  CheckSquareIcon,
  CloudIcon,
  CodeIcon,
  CoffeeIcon,
  CompassIcon,
  DollarSignIcon,
  GamepadIcon,
  GraduationCapIcon,
  HammerIcon,
  ImageIcon,
  LayoutPanelTopIcon,
  LeafIcon,
  MapIcon,
  NewspaperIcon,
  SearchIcon,
  UsersIcon,
} from 'lucide-react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { GenericCategoryIcon } from '@/features/DiscoverCategory/categoryIcon';
import { type DiscoverCategoryItem } from '@/features/DiscoverCategory/mergeCategories';
import {
  useDiscoverCategories,
  type UseDiscoverCategoriesOptions,
} from '@/features/DiscoverCategory/useDiscoverCategories';
import { McpCategory } from '@/types/discover';

/** The bundled list: the pseudo entries, then the built-in categories. */
const useLocalCategories = (): DiscoverCategoryItem[] => {
  const { t } = useTranslation('discover');
  return useMemo(
    () => [
      {
        icon: CompassIcon,
        key: McpCategory.Discover,
        label: t('mcp.categories.discover.name'),
        title: t('mcp.categories.discover.description'),
      },
      {
        icon: LayoutPanelTopIcon,
        key: McpCategory.All,
        label: t('mcp.categories.all.name'),
        title: t('mcp.categories.all.description'),
      },
      {
        icon: CodeIcon,
        key: McpCategory.Developer,
        label: t('mcp.categories.developer.name'),
        title: t('mcp.categories.developer.description'),
      },
      {
        icon: CheckSquareIcon,
        key: McpCategory.Productivity,
        label: t('mcp.categories.productivity.name'),
        title: t('mcp.categories.productivity.description'),
      },
      {
        icon: HammerIcon,
        key: McpCategory.Tools,
        label: t('mcp.categories.tools.name'),
        title: t('mcp.categories.tools.description'),
      },
      {
        icon: SearchIcon,
        key: McpCategory.WebSearch,
        label: t('mcp.categories.web-search.name'),
        title: t('mcp.categories.web-search.description'),
      },
      {
        icon: ImageIcon,
        key: McpCategory.MediaGenerate,
        label: t('mcp.categories.media-generate.name'),
        title: t('mcp.categories.media-generate.description'),
      },
      {
        icon: BriefcaseIcon,
        key: McpCategory.Business,
        label: t('mcp.categories.business.name'),
        title: t('mcp.categories.business.description'),
      },
      {
        icon: GraduationCapIcon,
        key: McpCategory.ScienceEducation,
        label: t('mcp.categories.science-education.name'),
        title: t('mcp.categories.science-education.description'),
      },
      {
        icon: DollarSignIcon,
        key: McpCategory.StocksFinance,
        label: t('mcp.categories.stocks-finance.name'),
        title: t('mcp.categories.stocks-finance.description'),
      },
      {
        icon: NewspaperIcon,
        key: McpCategory.News,
        label: t('mcp.categories.news.name'),
        title: t('mcp.categories.news.description'),
      },
      {
        icon: UsersIcon,
        key: McpCategory.Social,
        label: t('mcp.categories.social.name'),
        title: t('mcp.categories.social.description'),
      },
      {
        icon: GamepadIcon,
        key: McpCategory.GamingEntertainment,
        label: t('mcp.categories.gaming-entertainment.name'),
        title: t('mcp.categories.gaming-entertainment.description'),
      },
      {
        icon: CoffeeIcon,
        key: McpCategory.Lifestyle,
        label: t('mcp.categories.lifestyle.name'),
        title: t('mcp.categories.lifestyle.description'),
      },
      {
        icon: LeafIcon,
        key: McpCategory.HealthWellness,
        label: t('mcp.categories.health-wellness.name'),
        title: t('mcp.categories.health-wellness.description'),
      },
      {
        icon: MapIcon,
        key: McpCategory.TravelTransport,
        label: t('mcp.categories.travel-transport.name'),
        title: t('mcp.categories.travel-transport.description'),
      },
      {
        icon: CloudIcon,
        key: McpCategory.Weather,
        label: t('mcp.categories.weather.name'),
        title: t('mcp.categories.weather.description'),
      },
    ],
    [t],
  );
};

/**
 * The mcp categories a page shows: the pseudo entries, then the ones
 * Market has configured (its order and localized names), or the bundled list
 * while Market has none.
 */
export const useCategory = (options?: UseDiscoverCategoriesOptions) => {
  const local = useLocalCategories();
  return useDiscoverCategories('mcp', local, options);
};

/**
 * The entry of one asset's category. A category neither Market nor the bundled
 * list knows keeps a label (its translation if any, else the identifier) and the
 * generic icon, so a detail header or card never shows a blank.
 */
export const useCategoryItem = (key?: string): DiscoverCategoryItem | undefined => {
  const { t } = useTranslation('discover');
  const items = useCategory();
  if (!key) return;
  return (
    items.find((item) => item.key === key) ?? {
      icon: GenericCategoryIcon,
      key,
      label: t(`mcp.categories.${key}.name` as any, { defaultValue: key }),
    }
  );
};

import {
  BadgeDollarSignIcon,
  BriefcaseIcon,
  Coffee,
  CompassIcon,
  DramaIcon,
  GamepadIcon,
  GraduationCapIcon,
  ImageIcon,
  LanguagesIcon,
  LaughIcon,
  Layers,
  LayoutPanelTop,
  MicroscopeIcon,
  PencilIcon,
  PrinterIcon,
  TerminalSquareIcon,
} from 'lucide-react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { GenericCategoryIcon } from '@/features/DiscoverCategory/categoryIcon';
import { type DiscoverCategoryItem } from '@/features/DiscoverCategory/mergeCategories';
import {
  useDiscoverCategories,
  type UseDiscoverCategoriesOptions,
} from '@/features/DiscoverCategory/useDiscoverCategories';
import { AssistantCategory } from '@/types/discover';

/** The bundled list: the pseudo entries, then the built-in categories. */
const useLocalCategories = (): DiscoverCategoryItem[] => {
  const { t } = useTranslation('discover');

  return useMemo(
    () => [
      {
        icon: CompassIcon,
        key: AssistantCategory.Discover,
        label: t('category.assistant.discover'),
      },
      {
        icon: LayoutPanelTop,
        key: AssistantCategory.All,
        label: t('category.assistant.all'),
      },
      {
        icon: MicroscopeIcon,
        key: AssistantCategory.Academic,
        label: t('category.assistant.academic'),
      },
      {
        icon: BriefcaseIcon,
        key: AssistantCategory.Career,
        label: t('category.assistant.career'),
      },
      {
        icon: PencilIcon,
        key: AssistantCategory.CopyWriting,
        label: t('category.assistant.copywriting'),
      },
      {
        icon: ImageIcon,
        key: AssistantCategory.Design,
        label: t('category.assistant.design'),
      },
      {
        icon: GraduationCapIcon,
        key: AssistantCategory.Education,
        label: t('category.assistant.education'),
      },
      {
        icon: LaughIcon,
        key: AssistantCategory.Emotions,
        label: t('category.assistant.emotions'),
      },
      {
        icon: DramaIcon,
        key: AssistantCategory.Entertainment,
        label: t('category.assistant.entertainment'),
      },
      {
        icon: GamepadIcon,
        key: AssistantCategory.Games,
        label: t('category.assistant.games'),
      },
      {
        icon: Layers,
        key: AssistantCategory.General,
        label: t('category.assistant.general'),
      },
      {
        icon: Coffee,
        key: AssistantCategory.Life,
        label: t('category.assistant.life'),
      },
      {
        icon: BadgeDollarSignIcon,
        key: AssistantCategory.Marketing,
        label: t('category.assistant.marketing'),
      },
      {
        icon: PrinterIcon,
        key: AssistantCategory.Office,
        label: t('category.assistant.office'),
      },
      {
        icon: TerminalSquareIcon,
        key: AssistantCategory.Programming,
        label: t('category.assistant.programming'),
      },
      {
        icon: LanguagesIcon,
        key: AssistantCategory.Translation,
        label: t('category.assistant.translation'),
      },
    ],
    [t],
  );
};

/**
 * The agent categories a page shows: the pseudo entries, then the ones
 * Market has configured (its order and localized names), or the bundled list
 * while Market has none.
 */
export const useCategory = (options?: UseDiscoverCategoriesOptions) => {
  const local = useLocalCategories();
  return useDiscoverCategories('agent', local, options);
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
      label: t(`category.assistant.${key}` as any, { defaultValue: key }),
    }
  );
};

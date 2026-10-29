'use client';

import { COMMUNITY_SHOWCASE_LAYOUT } from '@lobechat/business-const';
import { Icon, Tag } from '@lobehub/ui';
import qs from 'query-string';
import { memo } from 'react';

import { withSuspense } from '@/components/withSuspense';
import { buildAssistantListQuery } from '@/features/CommunityAgentList/assistantListQuery';
import { useWorkspaceAwareNavigate } from '@/features/Workspace/useWorkspaceAwareNavigate';
import WorkspaceLink from '@/features/Workspace/WorkspaceLink';
import { useQuery } from '@/hooks/useQuery';
import { SCROLL_PARENT_ID } from '@/routes/(main)/community/features/const';
import { useDiscoverStore } from '@/store/discover';
import { assistantSelectors } from '@/store/discover/selectors';
import { AssistantCategory, type AssistantQueryParams, AssistantSorts } from '@/types/discover';

import CategoryMenu from '../../../../components/CategoryMenu';
import { buildShowcaseCategoryItems } from '../../../../features/Showcase/categoryItems';
import { useCategory } from './useCategory';

const Category = memo(() => {
  const useAssistantCategories = useDiscoverStore((s) => s.useFetchAssistantCategories);
  const useAssistantList = useDiscoverStore((s) => s.useFetchAssistantList);
  const query = useQuery() as AssistantQueryParams;
  const { category = AssistantCategory.Discover, q, source } = query;
  const { queryKey } = useAssistantList(buildAssistantListQuery(query));
  const data = useDiscoverStore(assistantSelectors.assistantList(queryKey));
  // Fallback counts while the list entry converges: the categories query is
  // keyed by `q` + `source` only, so switching category keeps its rows on screen
  // (the replica replacement for the old SWR `keepPreviousData`).
  const shouldLoadFallbackCategories = data?.categoryCounts === undefined;
  const { queryKey: categoriesQueryKey } = useAssistantCategories(
    { q, source },
    { enabled: shouldLoadFallbackCategories },
  );
  const fallbackItems = useDiscoverStore(
    assistantSelectors.assistantCategories(categoriesQueryKey),
  );
  const items = data?.categoryCounts ?? fallbackItems;
  const navigate = useWorkspaceAwareNavigate();
  const cates = useCategory({ counts: items, searching: !!q });

  const genUrl = (key: string) =>
    qs.stringifyUrl(
      {
        query: {
          category: key === AssistantCategory.Discover ? null : key,
          q,
          sort: key === AssistantCategory.Discover ? AssistantSorts.Recommended : null,
        },
        url: '/community/agent',
      },
      { skipNull: true },
    );

  const handleClick = (key: string) => {
    navigate(genUrl(key));
    const scrollableElement = document?.querySelector(`#${SCROLL_PARENT_ID}`);
    if (!scrollableElement) return;
    scrollableElement.scrollTo({ behavior: 'smooth', top: 0 });
  };

  // The showcase market has no "discover" entry: "all" is the default and lists
  // everything in recommended order.
  if (COMMUNITY_SHOWCASE_LAYOUT) {
    const showcaseUrl = (key: string) =>
      key === AssistantCategory.All ? genUrl(AssistantCategory.Discover) : genUrl(key);
    return (
      <CategoryMenu
        mode={'inline'}
        selectedKeys={[category === AssistantCategory.Discover ? AssistantCategory.All : category]}
        items={buildShowcaseCategoryItems(cates, {
          exclude: [AssistantCategory.Discover],
          genUrl: showcaseUrl,
          hideEmpty: false,
          order: [
            'office',
            'marketing',
            'programming',
            'career',
            'copywriting',
            'design',
            'academic',
            'translation',
            'general',
            'education',
            'life',
            'emotions',
            'entertainment',
            'games',
          ],
          kind: 'agent',
        })}
        onClick={(v) => {
          const key = String(v.key);
          navigate(showcaseUrl(key));
        }}
      />
    );
  }

  return (
    <CategoryMenu
      mode={'inline'}
      selectedKeys={[category]}
      items={cates.map((item) => {
        const { count, fromMarket: _fromMarket, ...rest } = item;
        return {
          extra: (item.key === 'all' ? !!count : count !== undefined) && (
            <Tag
              size={'small'}
              style={{
                borderRadius: 12,
                paddingInline: 6,
              }}
            >
              {count}
            </Tag>
          ),
          ...rest,
          icon: <Icon icon={item.icon} size={18} />,
          label: <WorkspaceLink to={genUrl(item.key)}>{item.label}</WorkspaceLink>,
        };
      })}
      onClick={(v) => handleClick(String(v.key))}
    />
  );
});

export default withSuspense(Category);

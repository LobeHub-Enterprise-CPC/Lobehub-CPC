'use client';

import { COMMUNITY_SHOWCASE_LAYOUT } from '@lobechat/business-const';
import { Icon, Tag } from '@lobehub/ui';
import qs from 'query-string';
import { memo } from 'react';

import { withSuspense } from '@/components/withSuspense';
import { useWorkspaceAwareNavigate } from '@/features/Workspace/useWorkspaceAwareNavigate';
import WorkspaceLink from '@/features/Workspace/WorkspaceLink';
import { useCategory } from '@/hooks/useMCPCategory';
import { useQuery } from '@/hooks/useQuery';
import { SCROLL_PARENT_ID } from '@/routes/(main)/community/features/const';
import { useDiscoverStore } from '@/store/discover';
import { mcpSelectors } from '@/store/discover/selectors';
import { McpCategory, McpSorts } from '@/types/discover';

import CategoryMenu from '../../../../components/CategoryMenu';
import { buildShowcaseCategoryItems } from '../../../../features/Showcase/categoryItems';

const Category = memo(() => {
  const useMcpCategories = useDiscoverStore((s) => s.useMcpCategories);
  const { category = McpCategory.Discover, q } = useQuery() as {
    category?: string;
    q?: string;
  };
  const { queryKey } = useMcpCategories({ q });
  const items = useDiscoverStore(mcpSelectors.mcpCategories(queryKey));
  const navigate = useWorkspaceAwareNavigate();
  const cates = useCategory({ counts: items, searching: !!q });

  const genUrl = (key: string) =>
    qs.stringifyUrl(
      {
        query: {
          category: key === McpCategory.Discover ? null : key,
          q,
          sort: key === McpCategory.Discover ? McpSorts.Recommended : null,
        },
        url: '/community/mcp',
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
      key === McpCategory.All ? genUrl(McpCategory.Discover) : genUrl(key);
    return (
      <CategoryMenu
        mode={'inline'}
        selectedKeys={[category === McpCategory.Discover ? McpCategory.All : category]}
        items={buildShowcaseCategoryItems(cates, {
          exclude: [McpCategory.Discover],
          genUrl: showcaseUrl,
          hideEmpty: false,
          order: [
            'developer',
            'productivity',
            'tools',
            'web-search',
            'media-generate',
            'business',
            'science-education',
            'stocks-finance',
            'news',
            'social',
            'gaming-entertainment',
            'lifestyle',
            'health-wellness',
            'travel-transport',
            'weather',
          ],
          kind: 'mcp',
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

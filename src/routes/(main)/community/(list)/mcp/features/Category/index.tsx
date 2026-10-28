'use client';

import { COMMUNITY_SHOWCASE_LAYOUT } from '@lobechat/business-const';
import { Icon, Tag } from '@lobehub/ui';
import qs from 'query-string';
import { memo, useMemo } from 'react';

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
    category?: McpCategory;
    q?: string;
  };
  const { queryKey } = useMcpCategories({ q });
  const items = useDiscoverStore(mcpSelectors.mcpCategories(queryKey));
  const navigate = useWorkspaceAwareNavigate();
  const cates = useCategory();

  const genUrl = (key: McpCategory) =>
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

  const handleClick = (key: McpCategory) => {
    navigate(genUrl(key));
    const scrollableElement = document?.querySelector(`#${SCROLL_PARENT_ID}`);
    if (!scrollableElement) return;
    scrollableElement.scrollTo({ behavior: 'smooth', top: 0 });
  };
  const total = useMemo(() => items.reduce((acc, item) => acc + item.count, 0), [items]);

  // The showcase market has no "discover" entry: "all" is the default and lists
  // everything in recommended order.
  if (COMMUNITY_SHOWCASE_LAYOUT) {
    const showcaseUrl = (key: McpCategory) =>
      key === McpCategory.All ? genUrl(McpCategory.Discover) : genUrl(key);
    return (
      <CategoryMenu
        mode={'inline'}
        selectedKeys={[category === McpCategory.Discover ? McpCategory.All : category]}
        items={buildShowcaseCategoryItems(cates as any, items as any, {
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
          const key = v.key as McpCategory;
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
        const itemData = items.find((i) => i.category === item.key);
        return {
          extra:
            item.key === 'all'
              ? total > 0 && (
                  <Tag
                    size={'small'}
                    style={{
                      borderRadius: 12,
                      paddingInline: 6,
                    }}
                  >
                    {total}
                  </Tag>
                )
              : itemData && (
                  <Tag
                    size={'small'}
                    style={{
                      borderRadius: 12,
                      paddingInline: 6,
                    }}
                  >
                    {itemData.count}
                  </Tag>
                ),
          ...item,
          icon: <Icon icon={item.icon} size={18} />,
          label: <WorkspaceLink to={genUrl(item.key)}>{item.label}</WorkspaceLink>,
        };
      })}
      onClick={(v) => handleClick(v.key as McpCategory)}
    />
  );
});

export default withSuspense(Category);

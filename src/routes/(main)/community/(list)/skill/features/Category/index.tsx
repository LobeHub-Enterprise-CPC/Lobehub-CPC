'use client';

import { COMMUNITY_SHOWCASE_LAYOUT } from '@lobechat/business-const';
import { Icon, Tag } from '@lobehub/ui';
import qs from 'query-string';
import { memo } from 'react';

import { withSuspense } from '@/components/withSuspense';
import { useWorkspaceAwareNavigate } from '@/features/Workspace/useWorkspaceAwareNavigate';
import WorkspaceLink from '@/features/Workspace/WorkspaceLink';
import { useQuery } from '@/hooks/useQuery';
import { useSkillCategory } from '@/hooks/useSkillCategory';
import { SCROLL_PARENT_ID } from '@/routes/(main)/community/features/const';
import { useDiscoverStore } from '@/store/discover';
import { skillSelectors } from '@/store/discover/selectors';
import { SkillCategory, SkillSorts } from '@/types/discover';

import CategoryMenu from '../../../../components/CategoryMenu';
import { buildShowcaseCategoryItems } from '../../../../features/Showcase/categoryItems';

const Category = memo(() => {
  const useSkillCategories = useDiscoverStore((s) => s.useSkillCategories);
  const { category = SkillCategory.All, q } = useQuery() as {
    category?: string;
    q?: string;
  };
  const { queryKey } = useSkillCategories({ q });
  const items = useDiscoverStore(skillSelectors.skillCategories(queryKey));
  const navigate = useWorkspaceAwareNavigate();
  const cates = useSkillCategory({ counts: items, searching: !!q });

  const genUrl = (key: string) =>
    qs.stringifyUrl(
      {
        query: {
          category: key === SkillCategory.All ? null : key,
          q,
          sort: key === SkillCategory.All ? SkillSorts.InstallCount : null,
        },
        url: '/community/skill',
      },
      { skipNull: true },
    );

  const handleClick = (key: string) => {
    navigate(genUrl(key));
    const scrollableElement = document?.querySelector(`#${SCROLL_PARENT_ID}`);
    if (!scrollableElement) return;
    scrollableElement.scrollTo({ behavior: 'smooth', top: 0 });
  };

  // The showcase market lists only categories something is filed under.
  if (COMMUNITY_SHOWCASE_LAYOUT) {
    const showcaseUrl = genUrl;
    return (
      <CategoryMenu
        mode={'inline'}
        selectedKeys={[category]}
        items={buildShowcaseCategoryItems(cates, {
          exclude: [],
          genUrl: showcaseUrl,
          hideEmpty: true,
          kind: 'skill',
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

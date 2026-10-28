'use client';

import { COMMUNITY_SHOWCASE_LAYOUT } from '@lobechat/business-const';
import { Flexbox } from '@lobehub/ui';
import { memo } from 'react';

import AsyncBoundary from '@/components/AsyncBoundary';
import { RouteLoading } from '@/components/Skeleton/RouteSegment';
import { useQuery } from '@/hooks/useQuery';
import { useSkillCategory } from '@/hooks/useSkillCategory';
import { useDiscoverStore } from '@/store/discover';
import { skillSelectors } from '@/store/discover/selectors';
import { type SkillQueryParams } from '@/types/discover';
import { DiscoverTab, SkillSorts } from '@/types/discover';

import SkillEmpty from '../../features/SkillEmpty';
import Pagination from '../features/Pagination';
import ShowcaseList from '../features/ShowcaseList';
import List from './features/List';

const SkillPage = memo(() => {
  const { q, page, category, sort, order } = useQuery() as SkillQueryParams;
  const useSkillList = useDiscoverStore((s) => s.useFetchSkillList);
  const { error, isLoading, mutate, queryKey } = useSkillList({
    category,
    order,
    page,
    pageSize: 21,
    q,
    sort: sort ?? SkillSorts.InstallCount,
  });
  // The replica view of this query; the sync hook only reports the fetch flags.
  const data = useDiscoverStore(skillSelectors.skillList(queryKey));

  const items = data?.items ?? [];
  const categoryLabels = useSkillCategory();
  // The featured row leads the unfiltered first page only: inside a category,
  // a search or a later page it would repeat what the list already shows.
  const featured =
    COMMUNITY_SHOWCASE_LAYOUT && !category && !q && (!page || Number(page) <= 1)
      ? items.filter((item) => item.isFeatured).slice(0, 3)
      : [];

  return (
    <AsyncBoundary
      data={data}
      empty={<SkillEmpty />}
      error={error}
      errorVariant={'page'}
      isEmpty={items.length === 0}
      isLoading={isLoading}
      loading={<RouteLoading />}
      onRetry={() => mutate()}
    >
      {data &&
        (COMMUNITY_SHOWCASE_LAYOUT ? (
          <ShowcaseList
            featured={featured.length > 0 && <List data={featured} />}
            footer={
              <Pagination
                currentPage={data.currentPage}
                pageSize={data.pageSize}
                tab={DiscoverTab.Skills}
                total={data.totalCount}
              />
            }
            title={
              category ? categoryLabels.find((item) => item.key === category)?.label : undefined
            }
          >
            <List data={items} />
          </ShowcaseList>
        ) : (
          <Flexbox gap={32} width={'100%'}>
            <List data={items} />
            <Pagination
              currentPage={data.currentPage}
              pageSize={data.pageSize}
              tab={DiscoverTab.Skills}
              total={data.totalCount}
            />
          </Flexbox>
        ))}
    </AsyncBoundary>
  );
});

export default SkillPage;

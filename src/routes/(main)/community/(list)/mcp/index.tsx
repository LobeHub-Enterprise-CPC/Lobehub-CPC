'use client';

import { COMMUNITY_SHOWCASE_LAYOUT } from '@lobechat/business-const';
import { Flexbox } from '@lobehub/ui';
import { memo } from 'react';

import AsyncBoundary from '@/components/AsyncBoundary';
import { RouteLoading } from '@/components/Skeleton/RouteSegment';
import { useCategory as useMcpCategory } from '@/hooks/useMCPCategory';
import { useQuery } from '@/hooks/useQuery';
import { useDiscoverStore } from '@/store/discover';
import { mcpSelectors } from '@/store/discover/selectors';
import { type McpQueryParams } from '@/types/discover';
import { DiscoverTab, McpSorts } from '@/types/discover';

import McpEmpty from '../../features/McpEmpty';
import Pagination from '../features/Pagination';
import ShowcaseList from '../features/ShowcaseList';
import List from './features/List';

const McpPage = memo(() => {
  const { q, page, category, sort, order } = useQuery() as McpQueryParams;
  const useMcpList = useDiscoverStore((s) => s.useFetchMcpList);
  const { error, isLoading, mutate, queryKey } = useMcpList({
    category,
    order,
    page,
    pageSize: 21,
    q,
    sort: sort ?? McpSorts.Recommended,
  });
  // The replica view of this query; the sync hook only reports the fetch flags.
  const data = useDiscoverStore(mcpSelectors.mcpList(queryKey));

  const items = data?.items ?? [];
  const categoryLabels = useMcpCategory();
  // The featured row leads the unfiltered first page only: inside a category,
  // a search or a later page it would repeat what the list already shows.
  const featured =
    COMMUNITY_SHOWCASE_LAYOUT && !category && !q && (!page || Number(page) <= 1)
      ? items.filter((item) => item.isFeatured).slice(0, 3)
      : [];

  return (
    <AsyncBoundary
      data={data}
      empty={<McpEmpty />}
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
                tab={DiscoverTab.Mcp}
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
              tab={DiscoverTab.Mcp}
              total={data.totalCount}
            />
          </Flexbox>
        ))}
    </AsyncBoundary>
  );
});

export default McpPage;

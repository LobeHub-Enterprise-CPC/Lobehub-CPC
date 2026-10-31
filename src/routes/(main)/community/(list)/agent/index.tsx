'use client';

import { COMMUNITY_SHOWCASE_LAYOUT } from '@lobechat/business-const';
import { Flexbox } from '@lobehub/ui';
import * as stylex from '@stylexjs/stylex';
import { memo } from 'react';
import urlJoin from 'url-join';

import AsyncBoundary from '@/components/AsyncBoundary';
import { RouteLoading } from '@/components/Skeleton/RouteSegment';
import { buildAssistantListQuery } from '@/features/CommunityAgentList/assistantListQuery';
import { useQuery } from '@/hooks/useQuery';
import { useDiscoverStore } from '@/store/discover';
import { assistantSelectors } from '@/store/discover/selectors';
import { type AssistantQueryParams } from '@/types/discover';
import { DiscoverTab } from '@/types/discover';

import AssistantEmpty from '../../features/AssistantEmpty';
import FeaturedAgentCard from '../../features/Showcase/FeaturedAgentCard';
import { gridStyles } from '../../features/Showcase/grid';
import Pagination from '../features/Pagination';
import ShowcaseList from '../features/ShowcaseList';
import { useCategory } from './features/Category/useCategory';
import List from './features/List';

const AssistantPage = memo(() => {
  const query = useQuery() as AssistantQueryParams;
  const useAssistantList = useDiscoverStore((s) => s.useFetchAssistantList);
  const { error, isLoading, mutate, queryKey } = useAssistantList(buildAssistantListQuery(query));
  // The replica view of this query; the sync hook only reports the fetch flags.
  const data = useDiscoverStore(assistantSelectors.assistantList(queryKey));

  const items = data?.items ?? [];
  const categoryLabels = useCategory();
  // The featured row leads the unfiltered first page only: inside a category,
  // a search or a later page it would repeat what the list already shows.
  const featured =
    COMMUNITY_SHOWCASE_LAYOUT &&
    !query.category &&
    !query.q &&
    (!query.page || Number(query.page) <= 1)
      ? items.filter((item) => item.isFeatured).slice(0, 4)
      : [];

  return (
    <AsyncBoundary
      data={data}
      empty={<AssistantEmpty />}
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
            featured={
              featured.length > 0 && (
                <div {...stylex.props(gridStyles.featured)}>
                  {featured.map((item, index) => (
                    <FeaturedAgentCard
                      author={item.author}
                      avatar={item.avatar}
                      backgroundColor={item.backgroundColor}
                      index={index}
                      key={item.identifier}
                      title={item.title || item.identifier}
                      to={urlJoin('/community/agent', item.identifier)}
                    />
                  ))}
                </div>
              )
            }
            footer={
              <Pagination
                currentPage={data.currentPage}
                pageSize={data.pageSize}
                tab={DiscoverTab.Assistants}
                total={data.totalCount}
              />
            }
            title={
              query.category
                ? categoryLabels.find((item) => item.key === query.category)?.label
                : undefined
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
              tab={DiscoverTab.Assistants}
              total={data.totalCount}
            />
          </Flexbox>
        ))}
    </AsyncBoundary>
  );
});

export default AssistantPage;

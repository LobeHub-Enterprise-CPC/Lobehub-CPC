import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';

import { useTaskStore } from '@/store/task';
import { TASK_COLLECTION_PAGE_SIZE } from '@/store/task/slices/list/action';

import {
  readScheduleFilters,
  readSchedulePage,
  SCHEDULE_FILTERS,
  type ScheduleFilter,
  scheduleFilterStatuses,
} from './filters';
import { ScheduledTasksWorkspace } from './ScheduledTasksWorkspace';

export const ScheduledTasksPage = ({
  agentId,
  projectId,
}: {
  agentId?: string;
  projectId?: string;
}) => {
  const [params, setParams] = useSearchParams();
  const [filters, setFilters] = useState(() => readScheduleFilters(params));
  useEffect(() => {
    setFilters(readScheduleFilters(params));
  }, [params]);
  const page = readSchedulePage(params);
  const sync = useTaskStore((s) => s.useFetchScheduledTaskList)({
    agentId,
    projectId,
    includeFinishedAutomation: true,
    enabled: filters.length > 0,
    limit: TASK_COLLECTION_PAGE_SIZE,
    offset: (page - 1) * TASK_COLLECTION_PAGE_SIZE,
    statuses: scheduleFilterStatuses(filters),
  });
  const total = filters.length > 0 ? (sync.data?.total ?? 0) : 0;
  const items = filters.length > 0 ? (sync.data?.data ?? []) : [];
  const setPage = (nextPage: number) => {
    const next = new URLSearchParams(params);
    if (nextPage === 1) next.delete('scheduledPage');
    else next.set('scheduledPage', String(nextPage));
    next.delete('scheduledTask');
    setParams(next, { replace: true });
  };
  const changeFilters = (value: ScheduleFilter[]) => {
    setFilters(value);
    const next = new URLSearchParams(params);
    if (value.length === SCHEDULE_FILTERS.length) next.delete('scheduledStatus');
    else next.set('scheduledStatus', value.join(','));
    next.delete('scheduledPage');
    next.delete('scheduledTask');
    setParams(next, { replace: true });
  };
  return (
    <ScheduledTasksWorkspace
      agentId={agentId}
      error={filters.length ? sync.error : undefined}
      filters={filters}
      isLoading={filters.length > 0 && sync.isLoading}
      items={items}
      page={page}
      pageSize={TASK_COLLECTION_PAGE_SIZE}
      projectId={projectId}
      total={total}
      onFiltersChange={changeFilters}
      onPageChange={setPage}
      onRefresh={() => {
        void sync.mutate();
      }}
    />
  );
};

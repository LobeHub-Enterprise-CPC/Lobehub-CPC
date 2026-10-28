import type { TaskStatus } from '@lobechat/types';

export const SCHEDULE_FILTERS = ['active', 'paused', 'completed'] as const;
export type ScheduleFilter = (typeof SCHEDULE_FILTERS)[number];

const STATUS_GROUPS: Record<ScheduleFilter, TaskStatus[]> = {
  active: ['backlog', 'scheduled', 'running', 'failed'],
  paused: ['paused'],
  completed: ['completed', 'canceled'],
};

export const readScheduleFilters = (params: URLSearchParams): ScheduleFilter[] => {
  const value = params.get('scheduledStatus');
  return value === null
    ? [...SCHEDULE_FILTERS]
    : SCHEDULE_FILTERS.filter((key) => value.split(',').includes(key));
};

export const scheduleFilterStatuses = (filters: ScheduleFilter[]): TaskStatus[] | undefined =>
  filters.length === SCHEDULE_FILTERS.length
    ? undefined
    : filters.flatMap((key) => STATUS_GROUPS[key]);

export const readSchedulePage = (params: URLSearchParams) => {
  const page = Number(params.get('scheduledPage') || 1);
  return Number.isSafeInteger(page) && page > 0 ? page : 1;
};

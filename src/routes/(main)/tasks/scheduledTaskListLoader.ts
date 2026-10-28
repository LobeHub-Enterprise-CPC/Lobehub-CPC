import type { LoaderFunctionArgs } from 'react-router';

import { getActiveWorkspaceSlug } from '@/business/client/hooks/useActiveWorkspaceSlug';
import {
  readScheduleFilters,
  readSchedulePage,
  scheduleFilterStatuses,
} from '@/features/AgentTasks/ScheduledTasks/filters';
import { PRE_PAINT_HYDRATE_TIMEOUT, settleWithin } from '@/libs/replica/prePaint';
import { getTaskStoreState } from '@/store/task';
import { TASK_COLLECTION_PAGE_SIZE } from '@/store/task/slices/list/action';

// Route loaders run before React commits the route: the only point where the
// persisted scheduled page (an async read) can land before the Tasks page
// paints its loading state. Only the scheduled tab reads it, and a reload
// always opens that tab on its first page.
export const scheduledTaskListLoader = async ({
  params,
  request,
}: Pick<LoaderFunctionArgs, 'params' | 'request'>): Promise<null> => {
  const searchParams = new URL(request.url).searchParams;
  if ((params.aid || params.projectId) && searchParams.get('collection') !== 'scheduled')
    return null;
  const filters = readScheduleFilters(searchParams);
  if (!filters.length) return null;
  // The URL → workspace switch runs after the route commits, so while the URL
  // enters another workspace the active scope is still the one being left;
  // reading it would seed the wrong partition. Leave that to the page's sync.
  if ((params.workspaceSlug ?? null) !== getActiveWorkspaceSlug()) return null;

  await settleWithin(
    getTaskStoreState().preHydrateScheduledTaskList({
      agentId: params.aid,
      limit: TASK_COLLECTION_PAGE_SIZE,
      offset: (readSchedulePage(searchParams) - 1) * TASK_COLLECTION_PAGE_SIZE,
      includeFinishedAutomation: true,
      statuses: scheduleFilterStatuses(filters),
      projectId: params.projectId,
    }),
    PRE_PAINT_HYDRATE_TIMEOUT,
  );

  return null;
};

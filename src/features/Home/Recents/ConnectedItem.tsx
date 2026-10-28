import { memo } from 'react';

import { taskDetailPath } from '@/features/AgentTasks/shared/taskDetailPath';
import WorkspaceLink from '@/features/Workspace/WorkspaceLink';
import { useActiveLocation } from '@/hooks/useActiveLocation';
import { useHomeStore } from '@/store/home';
import { homeRecentSelectors } from '@/store/home/selectors';
import type { RecentEntityRef } from '@/store/home/slices/recent/initialState';

import RecentListItem from './Item';

interface ConnectedItemProps {
  itemRef: RecentEntityRef;
  queryKey: string;
}

const ConnectedItem = memo<ConnectedItemProps>(({ itemRef, queryKey }) => {
  const item = useHomeStore(homeRecentSelectors.item(queryKey, itemRef));
  const { pathname } = useActiveLocation();
  if (!item) return null;
  // The open conversation or page: its id is the route's last segment.
  const active = pathname.split('/').at(-1) === item.id;

  // `slugTitle`, not `title`: the displayed title falls back to the task's
  // instruction, and feeding that into the path would publish a prompt body to
  // browser history, analytics and every copied link. `slugTitle` is the task's
  // own name, which is also what the detail page canonicalises to — so the slug
  // this link carries survives arrival instead of being rewritten.
  const route =
    item.type === 'task'
      ? taskDetailPath(item.id, item.agentId ?? undefined, item.slugTitle)
      : item.routePath;

  return (
    <WorkspaceLink style={{ color: 'inherit', textDecoration: 'none' }} to={route}>
      <RecentListItem {...item} active={active} />
    </WorkspaceLink>
  );
});

ConnectedItem.displayName = 'ConnectedRecentItem';

export default ConnectedItem;

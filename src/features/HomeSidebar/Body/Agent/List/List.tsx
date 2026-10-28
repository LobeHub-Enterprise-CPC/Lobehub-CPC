import { NAV_RAIL_ENABLED } from '@lobechat/business-const';
import { type SidebarAgentItem } from '@lobechat/types';
import { Flexbox } from '@lobehub/ui';
import { MoreHorizontal } from 'lucide-react';
import { type CSSProperties } from 'react';
import { memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { brandIcon } from '@/components/BrandIcon';
import NavItem from '@/features/NavPanel/components/NavItem';
import { useGlobalStore } from '@/store/global';
import { systemStatusSelectors } from '@/store/global/selectors';
import { useHomeStore } from '@/store/home';
import { homeAgentListSelectors } from '@/store/home/selectors';
import { SessionDefaultGroup } from '@/types/session';

import CreateAgentButton from '../CreateAgentButton';
import GroupItem from './AgentGroupItem';
import AgentItem from './AgentItem';
import { useKeepSidebarListed } from './useAgentList';

interface SessionListProps {
  dataSource: SidebarAgentItem[];
  groupId?: string;
  itemClassName?: string;
  itemStyle?: CSSProperties;
  onMoreClick?: () => void;
  visibility?: 'private' | 'public';
}

const List = memo<SessionListProps>(
  ({ onMoreClick, dataSource, groupId, itemStyle, itemClassName, visibility }) => {
    const { t } = useTranslation('chat');
    const { t: tCommon } = useTranslation('common');

    // Early return for empty state
    const isEmpty = useMemo(() => dataSource.length === 0, [dataSource.length]);

    // Check if this is defaultList and if there are more agents
    const isDefaultList = groupId === SessionDefaultGroup.Default;
    const ungroupedAgents = useHomeStore(homeAgentListSelectors.ungroupedAgents);
    const agentPageSize = useGlobalStore(systemStatusSelectors.agentPageSize);
    const openAllAgentsDrawer = useHomeStore((s) => s.openAllAgentsDrawer);
    const keep = useKeepSidebarListed();

    // Count what the sidebar can actually show (caller's unpins excluded) so
    // hidden items alone never surface a dangling "More" row.
    const listedCount = keep(ungroupedAgents).length;
    const hasMore = isDefaultList && listedCount > agentPageSize;

    // Empty custom/default groups always show the Create button so the user can populate them.
    // Non-empty lists only show it at the bottom of the default group; custom groups rely on
    // the group header dropdown for further additions. When the default list overflows and we
    // already render the "More" entry, hide the Create button to keep the footer compact —
    // creation is still reachable from the group header dropdown.
    const showCreateButton = isEmpty ? groupId !== undefined : isDefaultList && !hasMore;

    if (isEmpty) {
      return showCreateButton ? (
        <CreateAgentButton className={itemClassName} groupId={groupId} visibility={visibility} />
      ) : null;
    }

    return (
      <Flexbox gap={1}>
        {dataSource.map((item) =>
          item.type === 'group' ? (
            <GroupItem className={itemClassName} item={item} key={item.id} style={itemStyle} />
          ) : (
            <AgentItem className={itemClassName} item={item} key={item.id} style={itemStyle} />
          ),
        )}
        {hasMore &&
          (NAV_RAIL_ENABLED ? (
            // The two-level layout says how many agents the list leaves out, as
            // plain text in line with the names above it.
            <NavItem
              data-sidebar-row="more"
              icon={<span aria-hidden />}
              title={tCommon('navPanel.moreAgents', { count: listedCount - agentPageSize })}
              onClick={onMoreClick || openAllAgentsDrawer}
            />
          ) : (
            <NavItem
              icon={brandIcon('action.more', MoreHorizontal)}
              title={t('input.more')}
              onClick={onMoreClick || openAllAgentsDrawer}
            />
          ))}
        {showCreateButton && (
          <CreateAgentButton className={itemClassName} groupId={groupId} visibility={visibility} />
        )}
      </Flexbox>
    );
  },
);

export default List;

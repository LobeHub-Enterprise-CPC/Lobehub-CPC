'use client';

import { DEFAULT_AVATAR, DEFAULT_INBOX_AVATAR, DEFAULT_INBOX_TITLE } from '@lobechat/const';
import type { SidebarAgentItem } from '@lobechat/types';
import { agentDisplayName } from '@lobechat/types';
import { Flexbox, Tooltip } from '@lobehub/ui';
import { ActionIcon } from '@lobehub/ui/base-ui';
import { MoreHorizontal } from 'lucide-react';
import type { ReactNode } from 'react';
import { memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { useActiveWorkspaceSlug } from '@/business/client/hooks/useActiveWorkspaceSlug';
import Avatar from '@/components/Avatar';
import AgentGroupAvatar from '@/features/AgentGroupAvatar';
import { resolveInboxAgentRouteId } from '@/features/AgentRoute/useResolvedAgentRouteId';
import { resolveRouteOwnerId } from '@/features/NavPanel/routeKey';
import { useWorkspaceAwareNavigate } from '@/features/Workspace/useWorkspaceAwareNavigate';
import WorkspaceLink from '@/features/Workspace/WorkspaceLink';
import { useActiveLocation } from '@/hooks/useActiveLocation';
import { useAgentStore } from '@/store/agent';
import { agentSelectors, builtinAgentSelectors } from '@/store/agent/selectors';

import { useAgentList } from './List/useAgentList';

/** Avatars the row shows, the default agent included; the rest sit behind "…". */
const AVATAR_ROW_SIZE = 5;
const AVATAR_SIZE = 28;

interface AvatarLinkProps {
  active: boolean;
  children: ReactNode;
  title: string;
  to: string;
}

const AvatarLink = memo<AvatarLinkProps>(({ active, children, title, to }) => (
  <Tooltip title={title}>
    <WorkspaceLink
      aria-current={active ? 'page' : undefined}
      aria-label={title}
      data-brand-slot={'home-agent-avatar'}
      style={{ display: 'inline-flex', flex: 'none' }}
      to={to}
    >
      {children}
    </WorkspaceLink>
  </Tooltip>
));

const ItemAvatar = memo<{ item: SidebarAgentItem }>(({ item }) => {
  if (item.type === 'group') {
    const customAvatar = typeof item.avatar === 'string' ? item.avatar : undefined;
    return (
      <AgentGroupAvatar
        avatar={customAvatar}
        backgroundColor={item.backgroundColor || undefined}
        memberAvatars={Array.isArray(item.avatar) ? item.avatar : []}
        size={AVATAR_SIZE}
      />
    );
  }

  return (
    <Avatar
      emojiScaleWithBackground
      avatar={(typeof item.avatar === 'string' && item.avatar) || DEFAULT_AVATAR}
      background={item.backgroundColor || undefined}
      name={item.title || undefined}
      shape={'square'}
      size={AVATAR_SIZE}
    />
  );
});

/**
 * The Home panel's agents and groups as a row of avatars. An avatar opens the
 * profile; conversations start from there or from the home composer, and "…"
 * opens the full list.
 */
const AvatarRow = memo(() => {
  const { t } = useTranslation(['common', 'chat']);
  const navigate = useWorkspaceAwareNavigate();
  const { pathname } = useActiveLocation();
  const activeWorkspaceSlug = useActiveWorkspaceSlug();
  const activeOwnerId = resolveRouteOwnerId(pathname, activeWorkspaceSlug);

  const inboxAgentId = useAgentStore(builtinAgentSelectors.inboxAgentId);
  const inboxRouteAgentId = resolveInboxAgentRouteId(inboxAgentId);
  const inboxMeta = useAgentStore(agentSelectors.getAgentMetaById(inboxRouteAgentId));

  const { customList, defaultList, pinnedList } = useAgentList(false);
  const items = useMemo(() => {
    const seen = new Set<string>();
    return [...pinnedList, ...customList.flatMap((group) => group.items), ...defaultList]
      .filter((item) => !seen.has(item.id) && seen.add(item.id))
      .slice(0, AVATAR_ROW_SIZE - 1);
  }, [customList, defaultList, pinnedList]);

  return (
    <Flexbox horizontal align={'center'} data-brand-slot={'home-agent-avatars'} gap={8}>
      <AvatarLink
        active={activeOwnerId === inboxRouteAgentId || activeOwnerId === inboxAgentId}
        title={agentDisplayName(inboxMeta, DEFAULT_INBOX_TITLE)}
        to={`/agent/${inboxRouteAgentId}/profile`}
      >
        <Avatar
          emojiScaleWithBackground
          avatar={inboxMeta.avatar || DEFAULT_INBOX_AVATAR}
          shape={'square'}
          size={AVATAR_SIZE}
        />
      </AvatarLink>
      {items.map((item) => (
        <AvatarLink
          active={activeOwnerId === item.id}
          key={item.id}
          to={`/${item.type === 'group' ? 'group' : 'agent'}/${item.id}/profile`}
          title={agentDisplayName(
            item,
            t(item.type === 'group' ? 'untitledGroup' : 'untitledAgent', { ns: 'chat' }),
          )}
        >
          <ItemAvatar item={item} />
        </AvatarLink>
      ))}
      <ActionIcon
        icon={MoreHorizontal}
        size={'small'}
        title={t('navPanel.viewAllAgents')}
        onClick={() => navigate('/agents')}
      />
    </Flexbox>
  );
});

AvatarRow.displayName = 'AvatarRow';

export default AvatarRow;

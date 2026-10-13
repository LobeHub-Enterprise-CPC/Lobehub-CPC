import { agentDisplayName } from '@lobechat/types';
import { useTranslation } from 'react-i18next';

import { DEFAULT_AVATAR, DEFAULT_INBOX_AVATAR, DEFAULT_INBOX_TITLE } from '@/const/meta';
import { useAgentStore } from '@/store/agent';
import { agentSelectors, builtinAgentSelectors } from '@/store/agent/selectors';
import { useHomeStore } from '@/store/home';
import { homeAgentListSelectors } from '@/store/home/selectors';

import { useResolvedHomeAgentId } from './useResolvedHomeAgentId';

/**
 * Title and avatar of the agent the home composer currently talks to, falling
 * back to the inbox agent while no other one is resolved.
 */
export const useHomeAgentDisplay = () => {
  const { t } = useTranslation('common');
  const inboxAgentId = useAgentStore(builtinAgentSelectors.inboxAgentId);
  const { agentId: resolvedAgentId, isInbox } = useResolvedHomeAgentId();
  const agentId = resolvedAgentId ?? '';
  const inboxMeta = useAgentStore(agentSelectors.getAgentMetaById(inboxAgentId ?? ''));
  const sidebarItem = useHomeStore(homeAgentListSelectors.getAgentById(agentId));
  const agentMapMeta = useAgentStore(agentSelectors.getAgentMetaById(agentId));
  const isInboxFallback = isInbox || !resolvedAgentId;
  const meta = isInboxFallback ? inboxMeta : (sidebarItem ?? agentMapMeta);

  return {
    agentId,
    avatar:
      (typeof meta?.avatar === 'string' ? meta.avatar : undefined) ||
      (isInboxFallback ? DEFAULT_INBOX_AVATAR : DEFAULT_AVATAR),
    backgroundColor: meta?.backgroundColor || undefined,
    isInboxFallback,
    title: agentDisplayName(meta, isInboxFallback ? DEFAULT_INBOX_TITLE : t('defaultSession')),
  };
};

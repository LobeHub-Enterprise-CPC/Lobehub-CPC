'use client';

import { Segmented } from '@lobehub/ui';
import { memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { useAgentShareSupported } from '@/business/client/useAgentShareSupported';
import { useResourceAccess } from '@/features/ResourcePermission/useResourceAccess';
import { useWorkspaceAwareNavigate } from '@/features/Workspace/useWorkspaceAwareNavigate';
import { usePermission } from '@/hooks/usePermission';
import { featureFlagsSelectors, useServerConfigStore } from '@/store/serverConfig';

import {
  type AgentProfileTab,
  buildAgentProfileTabOptions,
  buildAgentProfileTabPath,
} from './tabOptions';

export type { AgentProfileTab } from './tabOptions';

/**
 * The showcase layout's page column for the agent profile group and the group
 * profile: the design's 1119px content frame, a 1023px body 48px in from each
 * side. The tab bar and every tab's body share it, so they stay aligned at any
 * window width.
 */
export const AGENT_PROFILE_SHOWCASE_COLUMN = 1120;

export { AGENT_PROFILE_TABS_CENTER_STYLE, getAgentProfileTabsCenterStyle } from './centerStyle';

interface AgentProfileTabsProps {
  /** The tab owned by the page rendering this switcher. */
  active: AgentProfileTab;
  agentId: string;
}

/**
 * Segmented switcher shared by the agent profile group — Profile / Channels /
 * Statistics / Share. The surfaces are separate routes, so a segment writes the
 * URL rather than holding local state: deep links and back/forward keep working.
 */
const AgentProfileTabs = memo<AgentProfileTabsProps>(({ active, agentId }) => {
  const { t } = useTranslation(['chat', 'common', 'spend']);
  const navigate = useWorkspaceAwareNavigate();

  const { allowed: canEditContent } = usePermission('edit_own_content');
  const { canEditResource, canManageResource, isAccessResolved } = useResourceAccess(
    'agent',
    agentId,
  );
  const { isAgentEditable } = useServerConfigStore(featureFlagsSelectors);

  const canConfigure = !!isAgentEditable && isAccessResolved && canEditContent && canEditResource;
  const canManageShare =
    !!isAgentEditable && isAccessResolved && canEditContent && canManageResource;
  const { visible: shareVisible } = useAgentShareSupported(agentId);

  const options = useMemo(
    () =>
      buildAgentProfileTabOptions({
        active,
        canConfigure,
        labels: {
          channel: t('tab.integration'),
          // Inside the profile group the whole surface *is* the agent profile,
          // so the first segment is the "basic" tab, not "Agent Profile" again —
          // that broader name stays on the sidebar entry that opens the group.
          profile: t('tab.profileBasic'),
          share: t('share', { ns: 'common' }),
          statistics: t('usageStats.title', { ns: 'spend' }),
        },
        shareSupported: shareVisible === true && canManageShare,
      }),
    [active, canConfigure, canManageShare, shareVisible, t],
  );

  // A lone segment is a label, not a switcher.
  if (options.length < 2) return null;

  return (
    // Wrapped so a distribution theme can restyle and reposition the switcher.
    <div data-brand-slot={'agent-profile-tabs'}>
      <Segmented
        options={options}
        size={'small'}
        value={active}
        // `Segmented` only fires on a *change*, so the active segment is inert —
        // notably on `/channel/:platform`, where Channels stays selected. Going
        // back to the platform list is the breadcrumb's job, not this switcher's.
        onChange={(value) => navigate(buildAgentProfileTabPath(agentId, value as AgentProfileTab))}
      />
    </div>
  );
});

AgentProfileTabs.displayName = 'AgentProfileTabs';

export default AgentProfileTabs;

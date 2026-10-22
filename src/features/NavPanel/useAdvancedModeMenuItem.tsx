import { AGENT_PROFILE_NAVIGATION } from '@lobechat/business-const';
import { Icon } from '@lobehub/ui';
import { PanelLeftCloseIcon, PanelLeftOpenIcon } from 'lucide-react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { useActiveWorkspaceSlug } from '@/business/client/hooks/useActiveWorkspaceSlug';
import { useWorkspaceAwareNavigate } from '@/features/Workspace/useWorkspaceAwareNavigate';
import { useActiveLocation } from '@/hooks/useActiveLocation';
import { useGlobalStore } from '@/store/global';

import { resolveRouteOwnerId } from './routeKey';

/**
 * The profile "..." entry into and out of advanced mode: the agent's or
 * group's own workspace sidebar, otherwise hidden while the Home panel is the
 * only everyday navigation. `null` when that navigation is off or the route
 * has no agent or group.
 */
export const useAdvancedModeMenuItem = (type: 'agent' | 'group') => {
  const { t } = useTranslation('common');
  const navigate = useWorkspaceAwareNavigate();
  const { pathname } = useActiveLocation();
  const activeWorkspaceSlug = useActiveWorkspaceSlug();
  const advancedTargetId = useGlobalStore((s) => s.navAdvancedTargetId);
  const setNavAdvancedTarget = useGlobalStore((s) => s.setNavAdvancedTarget);
  // The route's own segment, so the panel key compares like with like.
  const ownerId = resolveRouteOwnerId(pathname, activeWorkspaceSlug);

  const active = !!ownerId && advancedTargetId === ownerId;

  return useMemo(() => {
    if (!AGENT_PROFILE_NAVIGATION || !ownerId) return null;

    return {
      icon: <Icon icon={active ? PanelLeftCloseIcon : PanelLeftOpenIcon} />,
      key: 'advanced-mode',
      label: t(active ? 'navPanel.exitAdvancedMode' : 'navPanel.advancedMode'),
      onClick: () => {
        if (active) {
          setNavAdvancedTarget(undefined);
          return;
        }
        setNavAdvancedTarget(ownerId);
        navigate(`/${type}/${ownerId}`);
      },
    };
  }, [active, navigate, ownerId, setNavAdvancedTarget, t, type]);
};

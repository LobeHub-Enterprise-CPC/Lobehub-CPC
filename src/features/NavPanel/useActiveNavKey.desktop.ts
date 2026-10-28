import { useEffect } from 'react';

import { useActiveWorkspaceSlug } from '@/business/client/hooks/useActiveWorkspaceSlug';
import { useDisplayedTabUrl } from '@/features/Electron/TabHost/displayedTab';
import { useGlobalStore } from '@/store/global';

import { resolveNavPanelKey, resolveRouteOwnerId } from './routeKey';

// The route-owned panel registers from inside the tab's layout, so keying the
// panel by the clicked tab before its pane is on screen finds no entry and
// paints the skeleton.
export const useActiveNavKey = () => {
  const url = useDisplayedTabUrl() ?? '/';
  const activeWorkspaceSlug = useActiveWorkspaceSlug();
  const advancedTargetId = useGlobalStore((s) => s.navAdvancedTargetId);
  const pathname = url.split(/[#?]/)[0] || '/';

  return resolveNavPanelKey(pathname, activeWorkspaceSlug, advancedTargetId);
};

/** Leaves advanced mode only once the displayed tab no longer belongs to its owner. */
export const useExitNavAdvancedMode = () => {
  const url = useDisplayedTabUrl() ?? '/';
  const activeWorkspaceSlug = useActiveWorkspaceSlug();
  const advancedTargetId = useGlobalStore((s) => s.navAdvancedTargetId);
  const setNavAdvancedTarget = useGlobalStore((s) => s.setNavAdvancedTarget);
  const pathname = url.split(/[#?]/)[0] || '/';
  const ownerId = resolveRouteOwnerId(pathname, activeWorkspaceSlug);

  useEffect(() => {
    if (advancedTargetId && ownerId !== advancedTargetId) setNavAdvancedTarget(undefined);
  }, [advancedTargetId, ownerId, setNavAdvancedTarget]);
};

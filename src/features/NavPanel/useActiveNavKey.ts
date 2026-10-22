import { useEffect } from 'react';

import { useActiveWorkspaceSlug } from '@/business/client/hooks/useActiveWorkspaceSlug';
import { useActiveLocation } from '@/hooks/useActiveLocation';
import { useGlobalStore } from '@/store/global';

import { resolveNavPanelKey, resolveRouteOwnerId } from './routeKey';

export const useActiveNavKey = () => {
  const { pathname } = useActiveLocation();
  const activeWorkspaceSlug = useActiveWorkspaceSlug();
  const advancedTargetId = useGlobalStore((s) => s.navAdvancedTargetId);

  return resolveNavPanelKey(pathname, activeWorkspaceSlug, advancedTargetId);
};

/** Leaves advanced mode once the route no longer belongs to that agent or group. */
export const useExitNavAdvancedMode = () => {
  const { pathname } = useActiveLocation();
  const activeWorkspaceSlug = useActiveWorkspaceSlug();
  const advancedTargetId = useGlobalStore((s) => s.navAdvancedTargetId);
  const setNavAdvancedTarget = useGlobalStore((s) => s.setNavAdvancedTarget);
  const ownerId = resolveRouteOwnerId(pathname, activeWorkspaceSlug);

  useEffect(() => {
    if (advancedTargetId && ownerId !== advancedTargetId) setNavAdvancedTarget(undefined);
  }, [advancedTargetId, ownerId, setNavAdvancedTarget]);
};

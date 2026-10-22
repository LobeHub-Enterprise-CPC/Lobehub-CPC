import { AGENT_PROFILE_NAVIGATION, PROJECT_FIRST_NAVIGATION } from '@lobechat/business-const';

const routeSegmentsOf = (pathname: string, activeWorkspaceSlug: string | null) => {
  const segments = pathname.split('/').filter(Boolean);
  const isWorkspaceRoute =
    !!activeWorkspaceSlug && segments.length > 0 && segments[0] === activeWorkspaceSlug;

  return { isWorkspaceRoute, routeSegments: isWorkspaceRoute ? segments.slice(1) : segments };
};

/** The agent or group a path belongs to (`/agent/:aid/…`, `/group/:gid/…`), if any. */
export const resolveRouteOwnerId = (
  pathname: string,
  activeWorkspaceSlug: string | null,
): string | undefined => {
  const [rootSegment, childSegment] = routeSegmentsOf(pathname, activeWorkspaceSlug).routeSegments;

  return rootSegment === 'agent' || rootSegment === 'group' ? childSegment : undefined;
};

/**
 * @param advancedTargetId the agent or group in advanced mode — the only one
 *   whose own sidebar shows while the Home panel is the only everyday navigation
 */
export const resolveNavPanelKey = (
  pathname: string,
  activeWorkspaceSlug: string | null,
  advancedTargetId?: string,
): string => {
  const { isWorkspaceRoute, routeSegments } = routeSegmentsOf(pathname, activeWorkspaceSlug);
  const [rootSegment, childSegment, grandchildSegment, leafSegment] = routeSegments;
  // Profiles and conversations open from the Home panel, which stays put.
  const keepsHomePanel = AGENT_PROFILE_NAVIGATION && childSegment !== advancedTargetId;

  if (rootSegment === 'settings') {
    return isWorkspaceRoute ? 'workspace-settings' : 'settings';
  }

  switch (rootSegment) {
    case 'channels': {
      return 'home';
    }

    case 'agent': {
      if (keepsHomePanel) return 'home';
      return grandchildSegment === 'docs' ? 'agent-docs' : 'agent';
    }

    case 'community': {
      return 'discover';
    }

    case 'eval': {
      return childSegment === 'bench' ? 'evalBench' : 'eval';
    }

    case 'group': {
      return keepsHomePanel ? 'home' : 'group';
    }

    case 'image': {
      return 'image';
    }

    case 'memory': {
      return 'memory';
    }

    case 'page': {
      return 'page';
    }

    case 'project': {
      // A project conversation opens from the Home panel, which lists it, so the
      // panel stays put. The project page (no topic picked) keeps its sidebar.
      if (PROJECT_FIRST_NAVIGATION && grandchildSegment === 'conversation' && leafSegment)
        return 'home';
      return 'project';
    }

    case 'resource': {
      return childSegment === 'library' ? 'resourceLibrary' : 'resource';
    }

    case 'video': {
      return 'video';
    }

    default: {
      return 'home';
    }
  }
};

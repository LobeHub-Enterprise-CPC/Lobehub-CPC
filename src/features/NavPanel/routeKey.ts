import { PROJECT_FIRST_NAVIGATION } from '@lobechat/business-const';

export const resolveNavPanelKey = (
  pathname: string,
  activeWorkspaceSlug: string | null,
): string => {
  const segments = pathname.split('/').filter(Boolean);
  const isWorkspaceRoute =
    !!activeWorkspaceSlug && segments.length > 0 && segments[0] === activeWorkspaceSlug;
  const routeSegments = isWorkspaceRoute ? segments.slice(1) : segments;
  const [rootSegment, childSegment, grandchildSegment, leafSegment] = routeSegments;

  if (rootSegment === 'settings') {
    return isWorkspaceRoute ? 'workspace-settings' : 'settings';
  }

  switch (rootSegment) {
    case 'channels': {
      return 'home';
    }

    case 'agent': {
      return grandchildSegment === 'docs' ? 'agent-docs' : 'agent';
    }

    case 'community': {
      return 'discover';
    }

    case 'eval': {
      return childSegment === 'bench' ? 'evalBench' : 'eval';
    }

    case 'group': {
      return 'group';
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

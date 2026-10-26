export type HomeDockWorkspaceView = 'device-only' | 'hidden' | 'pending' | 'workspace';

export interface ResolveHomeDockWorkspaceParams {
  canConfigureResource: boolean;
  isAccessLoading: boolean;
  isAgentConfigLoading: boolean;
  isAgentRuntimeMode: boolean;
  isHeterogeneous: boolean;
  isPreferenceLoading: boolean;
}

/**
 * What the home dock's right group shows. Mirrors the topic control bars:
 * heterogeneous agents always get a workspace (device only, when the member
 * cannot edit), normal agents only in agent-runtime mode. Pending covers
 * config / access / mode-preference loads so the wrong cluster never flashes.
 */
export const resolveHomeDockWorkspace = ({
  canConfigureResource,
  isAccessLoading,
  isAgentConfigLoading,
  isAgentRuntimeMode,
  isHeterogeneous,
  isPreferenceLoading,
}: ResolveHomeDockWorkspaceParams): HomeDockWorkspaceView => {
  if (isAgentConfigLoading) return 'pending';

  if (isHeterogeneous) {
    if (isAccessLoading) return 'pending';
    return canConfigureResource ? 'workspace' : 'device-only';
  }

  if (isAccessLoading || isPreferenceLoading) return 'pending';
  if (!isAgentRuntimeMode) return 'hidden';

  return 'workspace';
};

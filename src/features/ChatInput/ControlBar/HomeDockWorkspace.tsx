'use client';

import { memo } from 'react';

import { SkeletonBar } from '@/components/Skeleton';
import { useAgentStore } from '@/store/agent';
import { agentByIdSelectors } from '@/store/agent/selectors';

import { useChatInputResourceAccess } from '../hooks/useChatInputResourceAccess';
import { useEffectiveAgentMode } from '../hooks/useEffectiveAgentMode';
import { createStore, Provider } from '../store';
import StoreUpdater from '../StoreUpdater';
import { ExecutionPlacePicker } from './executionPlace/ExecutionPlacePicker';
import { resolveHomeDockWorkspace } from './resolveHomeDockWorkspace';
import WorkspaceControls from './WorkspaceControls';

const HomeDockWorkspaceSkeleton = ({ className }: { className?: string }) => (
  <div aria-busy className={className} data-pending={'config'} data-testid={'home-dock-workspace'}>
    <SkeletonBar height={22} radius={4} width={88} />
    <SkeletonBar height={22} radius={4} width={120} />
  </div>
);

const HomeDockWorkspaceBody = memo<{ agentId: string; className?: string }>(
  ({ agentId, className }) => {
    const isAgentConfigLoading = useAgentStore((s) =>
      agentByIdSelectors.isAgentConfigLoadingById(agentId)(s),
    );
    const isHeterogeneous = useAgentStore((s) =>
      agentByIdSelectors.isAgentHeterogeneousById(agentId)(s),
    );
    // Inside the dock store, where topicId is null, so the mode follows this
    // agent's own model and not the global active topic.
    const { isAgentRuntimeMode, isPreferenceLoading } = useEffectiveAgentMode(agentId);
    const { canConfigureResource, isAccessLoading } = useChatInputResourceAccess();

    const view = resolveHomeDockWorkspace({
      canConfigureResource,
      isAccessLoading,
      isAgentConfigLoading,
      isAgentRuntimeMode,
      isHeterogeneous,
      isPreferenceLoading,
    });

    if (view === 'hidden') return null;
    if (view === 'pending') return <HomeDockWorkspaceSkeleton className={className} />;

    return (
      <div className={className} data-testid={'home-dock-workspace'}>
        {view === 'device-only' ? (
          <ExecutionPlacePicker agentId={agentId} allowDirectory={false} placement={'left'} />
        ) : (
          <WorkspaceControls
            placePicker
            agentId={agentId}
            alwaysShowWorkspace={isHeterogeneous}
            placePickerPlacement={'left'}
          />
        )}
      </div>
    );
  },
);

HomeDockWorkspaceBody.displayName = 'HomeDockWorkspaceBody';

export interface HomeDockWorkspaceProps {
  agentId: string;
  className?: string;
}

/**
 * Device and working-directory cluster for the home composer. The home page
 * has no topic; seeding `topicId: null` (and not leaving it `undefined`) keeps
 * every reused control off `useChatStore.activeTopicId`.
 */
const HomeDockWorkspace = memo<HomeDockWorkspaceProps>(({ agentId, className }) => (
  <Provider
    key={agentId}
    createStore={() =>
      createStore({
        agentId,
        topicId: null,
      })
    }
  >
    <StoreUpdater agentId={agentId} topicId={null} />
    <HomeDockWorkspaceBody agentId={agentId} className={className} />
  </Provider>
));

HomeDockWorkspace.displayName = 'HomeDockWorkspace';

export default HomeDockWorkspace;

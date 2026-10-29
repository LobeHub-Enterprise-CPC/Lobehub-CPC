'use client';

import {
  AGENT_PROFILE_SHOWCASE_LAYOUT,
  EXTERNAL_INTEGRATIONS_ENABLED,
} from '@lobechat/business-const';
import { createStaticStyles, Flexbox } from '@lobehub/ui';
import { memo, type ReactNode, useCallback, useMemo } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router';

import NotFound from '@/components/404';
import AsyncBoundary from '@/components/AsyncBoundary';
import {
  AgentChannelDetailBodySkeleton,
  AgentChannelListBodySkeleton,
} from '@/components/Skeleton/AgentChannel';
import PlatformDetail from '@/features/AgentChannel/PlatformDetail';
import ComingSoonDetail from '@/features/AgentChannel/PlatformDetail/ComingSoon';
import PlatformGrid from '@/features/AgentChannel/PlatformGrid';
import { useAgentChannels } from '@/features/AgentChannel/useAgentChannels';
import { AGENT_PROFILE_SHOWCASE_COLUMN } from '@/features/AgentProfileTabs';
import ResourceConfigAccessGate from '@/features/ResourcePermission/ResourceConfigAccessGate';
import { usePermission } from '@/hooks/usePermission';

import Header from './Header';

const styles = createStaticStyles(({ css }) => ({
  container: css`
    overflow-y: auto;
    display: flex;
    flex: 1;
    flex-direction: column;
    align-items: center;

    width: 100%;
    height: 100%;
  `,
}));

// The showcase layout puts each channel page in the profile group's column,
// under the tabs, instead of letting it centre on its own width.
const ShowcaseColumn = ({ children }: { children: ReactNode }) =>
  AGENT_PROFILE_SHOWCASE_LAYOUT ? (
    <div style={{ maxWidth: AGENT_PROFILE_SHOWCASE_COLUMN, paddingInline: 48, width: '100%' }}>
      {children}
    </div>
  ) : (
    children
  );

const ChannelContent = memo(() => {
  const { aid, platform } = useParams<{ aid?: string; platform?: string }>();
  const navigate = useNavigate();
  const { allowed: canEdit } = usePermission('edit_own_content');

  const {
    allPlatforms,
    error,
    hasData,
    isLoading,
    platformRuntimeStatuses,
    platforms,
    platformsLoading,
    providers,
    retry,
  } = useAgentChannels(aid, canEdit);

  const activePlatformDef = useMemo(
    () => (platform ? allPlatforms.find((item) => item.id === platform) : undefined),
    [allPlatforms, platform],
  );

  const currentConfig = useMemo(
    () => providers?.find((item) => item.platform === platform),
    [platform, providers],
  );

  const handleSelectPlatform = useCallback(
    (platformId: string) => navigate(platformId, { relative: 'path' }),
    [navigate],
  );

  if (!aid) return null;

  return (
    <Flexbox flex={1} height={'100%'} style={{ overflow: 'hidden' }}>
      <Header
        agentId={aid}
        currentConfig={currentConfig}
        disabled={!canEdit}
        platformDef={activePlatformDef}
        platformId={platform}
        platformsLoading={platformsLoading}
        providers={providers}
        runtimeStatus={
          activePlatformDef ? platformRuntimeStatuses.get(activePlatformDef.id) : undefined
        }
      />
      <Flexbox flex={1} style={{ overflow: 'hidden' }}>
        <AsyncBoundary
          data={hasData ? platforms : undefined}
          error={error}
          errorVariant={'block'}
          isLoading={isLoading}
          // Body half of the route skeleton (the real header is already mounted),
          // so the chunk wait and the platform fetch share one shape.
          loading={platform ? <AgentChannelDetailBodySkeleton /> : <AgentChannelListBodySkeleton />}
          onRetry={retry}
        >
          {!platform ? (
            <div className={styles.container}>
              <ShowcaseColumn>
                <PlatformGrid
                  agentId={aid}
                  platforms={allPlatforms}
                  runtimeStatuses={platformRuntimeStatuses}
                  onSelect={handleSelectPlatform}
                />
              </ShowcaseColumn>
            </div>
          ) : activePlatformDef ? (
            <div className={styles.container}>
              <ShowcaseColumn>
                {activePlatformDef.comingSoon ? (
                  <ComingSoonDetail platformDef={activePlatformDef} />
                ) : (
                  <PlatformDetail
                    agentId={aid}
                    currentConfig={currentConfig}
                    disabled={!canEdit}
                    platformDef={activePlatformDef}
                  />
                )}
              </ShowcaseColumn>
            </div>
          ) : (
            <NotFound />
          )}
        </AsyncBoundary>
      </Flexbox>
    </Flexbox>
  );
});

const ChannelPage = () => {
  const { aid } = useParams<{ aid?: string }>();

  // The nav entry is hidden by the same flag, so the only way here is a typed
  // URL or a stale link — and landing on a grid of messengers the deployment
  // cannot connect is worse than not offering the page at all.
  if (!EXTERNAL_INTEGRATIONS_ENABLED) return <Navigate replace to={`/agent/${aid ?? ''}`} />;

  return (
    <ResourceConfigAccessGate
      redirectPath={`/agent/${aid ?? ''}`}
      resourceId={aid}
      resourceType="agent"
    >
      <ChannelContent />
    </ResourceConfigAccessGate>
  );
};

export default ChannelPage;

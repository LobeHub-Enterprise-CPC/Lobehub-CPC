import { AGENT_AVATAR_GALLERY, PROJECT_FIRST_NAVIGATION } from '@lobechat/business-const';
import { createStaticStyles } from '@lobehub/ui';
import { memo } from 'react';

import Avatar from '@/components/Avatar';
import { SkeletonBar } from '@/components/Skeleton';
import { useHomeStore } from '@/store/home';

import AgentSelect from '../AgentSelect';
import { useHomeAgentDisplay } from '../AgentSelect/useHomeAgentDisplay';
import { useResolvedHomeAgentId } from '../AgentSelect/useResolvedHomeAgentId';
import type { HomeMode } from '../types';
import ProjectSelect from './ProjectSelect';
import { useHomeDockWorkspace } from './useHomeDockWorkspace';

const AVATAR_SIZE = 80;

const styles = createStaticStyles(({ css, cssVar }) => ({
  // Sits behind the composer (which stacks at z-index 1), so only the part
  // above the composer's top edge shows.
  avatar: css`
    pointer-events: none;

    position: absolute;
    z-index: 0;
    inset-block-start: -44px;
    inset-inline-end: 32px;
  `,
  // Tucked under the composer the way the input banners are: the negative
  // margin slides it beneath the composer's rounded bottom edge.
  dock: css`
    position: relative;
    z-index: 0;

    display: flex;
    flex-wrap: nowrap;
    gap: 8px;
    align-items: center;

    min-width: 0;
    margin-block-start: -20px;
    margin-inline: 24px;
    padding-block: 26px 6px;
    padding-inline: 12px;
    border-radius: 0 0 16px 16px;

    background: ${cssVar.colorFillQuaternary};
  `,
  // Shares leftover width with the workspace cluster and gives it up when the
  // row is narrow, so the project / agent labels can ellipsize.
  leftGroup: css`
    overflow: hidden;
    display: flex;
    flex: 1 1 auto;
    gap: 8px;
    align-items: center;

    min-width: 0;

    & > * {
      min-width: 0;
    }
  `,
  // Long device / directory labels scroll inside the group instead of wrapping
  // or painting over the agent switcher. The scrollbar stays hidden.
  rightGroup: css`
    scrollbar-width: none;

    overflow: auto hidden;
    display: flex;
    flex: 1 1 auto;
    gap: 4px;
    align-items: center;
    justify-content: flex-end;

    min-width: 0;

    &::-webkit-scrollbar {
      display: none;
    }
  `,
}));

/**
 * The selected agent's avatar peeking over the composer. The inbox agent wears
 * the brand logo everywhere else; here it takes the gallery's default figure
 * when the distribution has one, so the spot always holds a character.
 */
export const AgentDockAvatar = memo(() => {
  const { avatar, backgroundColor, isInboxFallback, title } = useHomeAgentDisplay();
  const figure =
    isInboxFallback && AGENT_AVATAR_GALLERY ? AGENT_AVATAR_GALLERY.defaultAvatar : avatar;

  return (
    <div aria-hidden className={styles.avatar} data-brand-slot={'home-agent-dock-avatar'}>
      <Avatar
        avatar={figure}
        background={figure === avatar ? backgroundColor : undefined}
        key={figure}
        name={title}
        shape={'square'}
        size={AVATAR_SIZE}
      />
    </div>
  );
});

AgentDockAvatar.displayName = 'HomeAgentDockAvatar';

/**
 * The strip under the home composer that holds the agent switcher, led by the
 * project picker where conversations are organized by project.
 */
interface AgentDockProps {
  /** Home composer mode. Workspace controls belong only to an ordinary chat send. */
  mode: HomeMode;
}

const WorkspaceSkeleton = () => (
  <div
    aria-busy
    className={styles.rightGroup}
    data-pending={'chunk'}
    data-testid={'home-dock-workspace'}
  >
    <SkeletonBar height={22} radius={4} width={88} />
    <SkeletonBar height={22} radius={4} width={120} />
  </div>
);

const AgentDock = memo<AgentDockProps>(({ mode }) => {
  const inputActiveMode = useHomeStore((s) => s.inputActiveMode);
  const { agentId } = useResolvedHomeAgentId();
  const showWorkspace = mode === 'chat' && !inputActiveMode;
  const { failed, Workspace } = useHomeDockWorkspace(showWorkspace && !!agentId);

  return (
    <div className={styles.dock} data-brand-slot={'home-agent-dock'}>
      <div className={styles.leftGroup}>
        {PROJECT_FIRST_NAVIGATION && <ProjectSelect />}
        <AgentSelect />
      </div>
      {showWorkspace &&
        (agentId && Workspace ? (
          <Workspace agentId={agentId} className={styles.rightGroup} />
        ) : (
          !failed && <WorkspaceSkeleton />
        ))}
    </div>
  );
});

AgentDock.displayName = 'HomeAgentDock';

export default AgentDock;

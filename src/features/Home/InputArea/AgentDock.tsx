import { AGENT_AVATAR_GALLERY } from '@lobechat/business-const';
import { memo } from 'react';

import { createStaticStyles } from '@lobehub/ui';
import Avatar from '@/components/Avatar';

import AgentSelect from '../AgentSelect';
import { useHomeAgentDisplay } from '../AgentSelect/useHomeAgentDisplay';

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

/** The strip under the home composer that holds the agent switcher. */
const AgentDock = memo(() => (
  <div className={styles.dock} data-brand-slot={'home-agent-dock'}>
    <AgentSelect />
  </div>
));

AgentDock.displayName = 'HomeAgentDock';

export default AgentDock;

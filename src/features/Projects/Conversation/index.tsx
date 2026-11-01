'use client';

import { Flexbox, Text } from '@lobehub/ui';
import { cssVar } from '@lobehub/ui/stylex/cssVar.stylex';
import * as stylex from '@stylexjs/stylex';
import { memo } from 'react';

import ConversationWorkspace from '@/features/Conversation/Workspace';
import NavHeader from '@/features/NavHeader';
import ChatConversation from '@/routes/(main)/agent/features/Conversation';
import ChatHydration from '@/routes/(main)/agent/features/Conversation/ChatHydration';
import { conversationHeaderStyles } from '@/routes/(main)/agent/features/Conversation/Header';
import TerminalPanelToggle from '@/routes/(main)/agent/features/Conversation/Header/TerminalPanelToggle';
import WorkingPanelToggle from '@/routes/(main)/agent/features/Conversation/Header/WorkingPanelToggle';

import ProjectTopicActions from './ProjectTopicActions';
import { useProjectConversation } from './useProjectConversation';

// The agent conversation page's layout paints the column with the container
// background; this page has no such layout around it.
const styles = stylex.create({
  container: {
    position: 'relative',
    overflow: 'hidden',
    backgroundColor: cssVar.colorBgContainer,
  },
});

const ProjectConversation = memo(() => {
  const { fallback, getConversationPath, getTopicPath, title, topic } = useProjectConversation();

  if (fallback) return fallback;

  return (
    <Flexbox className={stylex.props(styles.container).className} flex={1} height={'100%'}>
      <ConversationWorkspace
        header={
          // The agent conversation header's frame, so the title, its "..." and
          // the message stream below sit where they do in an agent conversation.
          <div
            className={conversationHeaderStyles.container}
            data-brand-slot={'conversation-header'}
          >
            <NavHeader
              left={
                <Flexbox
                  allowShrink
                  horizontal
                  align="center"
                  className={conversationHeaderStyles.leftContent}
                  gap={4}
                >
                  <Text ellipsis style={{ marginInlineStart: 8 }} weight={600}>
                    {title}
                  </Text>
                  {topic && <ProjectTopicActions topic={topic} />}
                </Flexbox>
              }
              right={
                <Flexbox
                  horizontal
                  align="center"
                  className={conversationHeaderStyles.rightContent}
                  gap={4}
                >
                  <TerminalPanelToggle />
                  <WorkingPanelToggle />
                </Flexbox>
              }
              slotClassNames={{
                left: conversationHeaderStyles.slotLeft,
                right: conversationHeaderStyles.slotRight,
              }}
            />
          </div>
        }
      >
        <ChatHydration getConversationPath={getConversationPath} getTopicPath={getTopicPath} />
        <ChatConversation />
      </ConversationWorkspace>
    </Flexbox>
  );
});

ProjectConversation.displayName = 'ProjectConversation';

export default ProjectConversation;

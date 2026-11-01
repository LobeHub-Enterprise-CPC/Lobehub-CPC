'use client';

import { Flexbox, Text } from '@lobehub/ui';
import { memo } from 'react';

import NavHeader from '@/features/NavHeader';
import ChatHydration from '@/routes/(main)/agent/features/Conversation/ChatHydration';
import ConversationArea from '@/routes/(main)/agent/features/Conversation/ConversationArea';
import PortalPanel from '@/routes/(main)/agent/features/Portal/features/PortalPanel';

import ProjectTopicActions from './ProjectTopicActions';
import { useProjectConversation } from './useProjectConversation';

/**
 * Mobile has no working/terminal side panels: the project topic runs in the
 * same conversation stack as a mobile agent chat, under the page header.
 */
const MobileProjectConversation = memo(() => {
  const { fallback, getConversationPath, getTopicPath, title, topic } = useProjectConversation();

  if (fallback) return fallback;

  return (
    <Flexbox height={'100%'} style={{ minHeight: 0 }} width={'100%'}>
      <NavHeader
        right={topic && <ProjectTopicActions topic={topic} />}
        left={
          <Text ellipsis weight={600}>
            {title}
          </Text>
        }
      />
      <ChatHydration getConversationPath={getConversationPath} getTopicPath={getTopicPath} />
      <Flexbox flex={1} style={{ minHeight: 0, minWidth: 0, position: 'relative' }}>
        <ConversationArea />
      </Flexbox>
      <PortalPanel mobile />
    </Flexbox>
  );
});

MobileProjectConversation.displayName = 'MobileProjectConversation';

export default MobileProjectConversation;

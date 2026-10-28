'use client';

import { AGENT_AVATAR_GALLERY } from '@lobechat/business-const';
import { Avatar, Flexbox, Markdown, Text } from '@lobehub/ui';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { DEFAULT_AGENT_BUILDER_AVATAR, DEFAULT_INBOX_AVATAR } from '@/const/index';
import { conversationSelectors, useConversationStore } from '@/features/Conversation';
import { type SuggestMode } from '@/features/SuggestQuestions';
import { useAgentStore } from '@/store/agent';
import { agentByIdSelectors } from '@/store/agent/selectors';

import SuggestionChips from './SuggestionChips';

interface AgentBuilderWelcomeProps {
  disabled?: boolean;
  mode?: SuggestMode;
}

const AgentBuilderWelcome = memo<AgentBuilderWelcomeProps>(
  ({ disabled, mode = 'agentBuilder' }) => {
    const { t } = useTranslation('chat');
    const agentId = useConversationStore(conversationSelectors.agentId);
    const agent = useAgentStore(agentByIdSelectors.getAgentConfigById(agentId));

    return (
      <>
        <Flexbox flex={1} />
        <Flexbox
          gap={12}
          width={'100%'}
          style={{
            paddingBottom: 16,
          }}
        >
          <Avatar
            shape={'square'}
            size={78}
            avatar={
              agent?.avatar ||
              // A distribution with an avatar gallery gives the builder its own figure.
              (AGENT_AVATAR_GALLERY?.builtinAvatars?.agentBuilder
                ? DEFAULT_AGENT_BUILDER_AVATAR
                : DEFAULT_INBOX_AVATAR)
            }
          />
          <Text fontSize={24} weight={'bold'}>
            {t('agentBuilder.title')}
          </Text>
          <Markdown fontSize={14} variant={'chat'}>
            {t('agentBuilder.welcome')}
          </Markdown>
          <SuggestionChips builderAgentId={agentId} count={3} disabled={disabled} mode={mode} />
        </Flexbox>
      </>
    );
  },
);

export default AgentBuilderWelcome;

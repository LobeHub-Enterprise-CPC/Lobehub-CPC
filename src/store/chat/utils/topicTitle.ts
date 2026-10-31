import { resolveAssistantGroupFinalContent } from '@lobechat/conversation-flow';
import type { UIChatMessage } from '@lobechat/types';

import { LOADING_FLAT } from '@/const/message';

export const isAudioOnlyFirstUserMessage = (messages: UIChatMessage[]) => {
  const firstUserMessage = messages.find((message) => message.role === 'user');

  return Boolean(
    firstUserMessage && !firstUserMessage.content?.trim() && firstUserMessage.audioList?.length,
  );
};

export const normalizeTopicTitleMessages = (messages: UIChatMessage[]) =>
  messages
    .map((message) => {
      if (message.role !== 'assistantGroup' && message.role !== 'supervisor') return message;

      const content = resolveAssistantGroupFinalContent(message);
      return content ? { ...message, content, role: 'assistant' as const } : message;
    })
    .filter(
      (message) =>
        !(
          ['assistant', 'assistantGroup', 'supervisor'].includes(message.role) &&
          message.content?.trim() === LOADING_FLAT
        ),
    );

export const hasCompletedAssistantText = (messages: UIChatMessage[]) =>
  messages.some((message) => {
    if (
      message.role !== 'assistant' &&
      message.role !== 'assistantGroup' &&
      message.role !== 'supervisor'
    )
      return false;

    return !!resolveAssistantGroupFinalContent(message);
  });

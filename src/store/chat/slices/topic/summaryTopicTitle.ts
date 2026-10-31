import { TRACING_SCENARIOS } from '@lobechat/const';
import {
  chainSummaryTitle,
  TOPIC_TITLE_JSON_SCHEMA,
  TOPIC_TITLE_PROMPT_VERSION,
} from '@lobechat/prompts';
import { RequestTrigger, type UIChatMessage } from '@lobechat/types';

import { LOADING_FLAT } from '@/const/message';
import { aiChatService } from '@/services/aiChat';
import { topicService } from '@/services/topic';
import type { ChatStore } from '@/store/chat';
import {
  isAudioOnlyFirstUserMessage,
  normalizeTopicTitleMessages,
} from '@/store/chat/utils/topicTitle';
import { createServerConfigStore, getServerConfigStoreState } from '@/store/serverConfig/store';
import { useUserStore } from '@/store/user';
import { systemAgentSelectors, userGeneralSettingsSelectors } from '@/store/user/selectors';
import { merge } from '@/utils/merge';

import { topicSelectors } from './selectors';

export const summaryTopicTitle = async (
  get: () => ChatStore,
  summarizingTopicTitleIds: Set<string>,
  topicId: string,
  messages: UIChatMessage[],
): Promise<void> => {
  const { internal_updateTopicTitleInSummary } = get();
  const topic =
    topicSelectors.getTopicById(topicId)(get()) ?? (await topicService.getTopicDetail(topicId));
  if (!topic) return;

  const messagesForTitle = normalizeTopicTitleMessages(messages);

  // A voice-only first message has no text until the assistant responds. Do not
  // replace the visible default title with a loading placeholder for an empty
  // summary request; the run lifecycle retries with the completed reply.
  const hasTextContent = messagesForTitle.some((message) => {
    const content = message.content?.trim();
    return !!content && !(message.role === 'assistant' && content === LOADING_FLAT);
  });
  if (!hasTextContent && isAudioOnlyFirstUserMessage(messagesForTitle)) return;
  if (summarizingTopicTitleIds.has(topicId)) return;

  summarizingTopicTitleIds.add(topicId);

  // Keep an optimistic title like "阅读下面..." stable while AI rename runs;
  // otherwise the sidebar flickers `title -> ... -> final title`.
  const shouldShowPlaceholder = !topic.title || topic.title === LOADING_FLAT;

  if (shouldShowPlaceholder) internal_updateTopicTitleInSummary(topicId, LOADING_FLAT);

  const restorePreviousTitle = () => {
    if (shouldShowPlaceholder) internal_updateTopicTitleInSummary(topicId, topic.title);
  };

  // Structured generation, the same way `SystemAgentService.generateTopicTitle`
  // does it: the chain asks for `TOPIC_TITLE_JSON_SCHEMA`, so read the title
  // off the parsed object. Streaming a completion here used to write the raw
  // answer to `topic.title`, which named topics `{"title":"简单问候"}`.
  try {
    const serverStore = getServerConfigStoreState() && createServerConfigStore();
    if (serverStore && !serverStore.getState().serverConfigInit) {
      await new Promise<void>((resolve) => {
        const unsubscribe = serverStore.subscribe((state) => {
          if (!state.serverConfigInit) return;
          unsubscribe();
          resolve();
        });
      });
    }
    // Config initialization precedes the React effect that projects defaults
    // into the user store. Read that server layer now, keeping user overrides.
    const user = useUserStore.getState();
    const { model, provider } = systemAgentSelectors.topic({
      ...user,
      defaultSettings: merge(user.defaultSettings, {
        systemAgent: serverStore?.getState().serverConfig.systemAgent,
      }),
    });
    const { data } = await aiChatService.generateJSON(
      {
        ...chainSummaryTitle(
          messagesForTitle,
          userGeneralSettingsSelectors.currentResponseLanguage(useUserStore.getState()),
        ),
        metadata: { topicId, trigger: RequestTrigger.TopicTitle },
        model,
        provider,
        schema: TOPIC_TITLE_JSON_SCHEMA,
        tracing: {
          promptVersion: TOPIC_TITLE_PROMPT_VERSION,
          scenario: TRACING_SCENARIOS.TopicTitle,
          schemaName: TOPIC_TITLE_JSON_SCHEMA.name,
          topicId,
        },
      },
      new AbortController(),
    );

    const title = (data as { title?: string } | undefined)?.title?.trim();
    // An empty result must not blank the title — the placeholder would
    // otherwise stay in the sidebar forever.
    if (!title) return restorePreviousTitle();

    await get().internal_updateTopic(topicId, { title });
  } catch (error) {
    console.error('[summaryTopicTitle] failed to generate a title:', error);
    restorePreviousTitle();
  } finally {
    summarizingTopicTitleIds.delete(topicId);
  }
};

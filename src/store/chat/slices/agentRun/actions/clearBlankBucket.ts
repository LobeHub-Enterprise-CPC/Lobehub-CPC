import type { ConversationContext } from '@lobechat/types';

import type { ChatStore } from '@/store/chat/store';

/**
 * Empty an agent's blank (`_new`) conversation bucket once an isolated send
 * (Home composer, forwarding) has created its topic. Isolated callers move on to
 * the topic themselves and never switch the store to it, so nothing else clears
 * the optimistic pair they showed there. Left behind, the next blank send of the
 * agent (e.g. a direct @Agent) sent those rows as its new topic's messages and
 * moved them out of the topic they belong to.
 */
export const clearBlankConversationBucket = (
  get: () => ChatStore,
  { agentId, groupId, scope }: Pick<ConversationContext, 'agentId' | 'groupId' | 'scope'>,
) =>
  get().replaceMessages([], {
    action: 'clearBlankConversationBucket',
    context: { agentId, groupId, scope: scope ?? (groupId ? 'group' : 'main'), topicId: null },
  });

import { AGENT_PROFILE_NAVIGATION } from '@lobechat/business-const';
import { AGENT_CHAT_URL, GROUP_CHAT_URL } from '@lobechat/const';

/**
 * Where an agent or group on the agents page leads: its conversation, or its
 * profile when the Home panel is the only everyday navigation — the same place
 * its avatar in the Home panel opens, where a conversation starts.
 */
export const getAgentItemPath = ({ id, type }: { id: string; type?: string }) => {
  const chatPath = type === 'group' ? GROUP_CHAT_URL(id) : AGENT_CHAT_URL(id, false);

  return AGENT_PROFILE_NAVIGATION ? `${chatPath}/profile` : chatPath;
};

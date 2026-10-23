import { useChatStore } from '@/store/chat';
import { useGlobalStore } from '@/store/global';
import { useHomeStore } from '@/store/home';

/**
 * "New chat": the home composer with no project picked (and `agentId`, when
 * given, picked as the agent), focused and ready to type.
 *
 * The composer focuses itself only when it mounts, so it has to be focused here
 * as well: on Home already nothing remounts it, and the click leaves focus on
 * the button that was pressed.
 */
export const startNewHomeChat = (navigate: (path: string) => void, agentId?: string) => {
  useHomeStore.getState().setHomeSelectedProjectId(undefined);
  if (agentId) useGlobalStore.getState().updateSystemStatus({ homeSelectedAgentId: agentId });

  navigate('/');

  // After the navigation has committed, so a composer that mounts with it is the
  // one registered as the main input.
  requestAnimationFrame(() => useChatStore.getState().mainInputEditor?.focus());
};

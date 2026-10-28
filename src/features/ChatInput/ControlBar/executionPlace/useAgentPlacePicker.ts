import { COMPOSER_AGENT_ONLY_LAYOUT } from '@lobechat/business-const';

import {
  useActiveProjectDirectoryTopicId,
  useStagedProjectDirectoryId,
} from '../useProjectTopicDirectory';

/**
 * The place picker replaces the device and directory chips on the enterprise
 * topic bar (`COMPOSER_AGENT_ONLY_LAYOUT`) and on the home dock (`force`).
 * A project-directory conversation keeps `ProjectDeviceSwitcher`.
 */
export const useAgentPlacePicker = (agentId: string, force = false) => {
  const projectTopicId = useActiveProjectDirectoryTopicId();
  const stagedDirectoryId = useStagedProjectDirectoryId(agentId);
  const projectBound = Boolean(projectTopicId || stagedDirectoryId);

  return {
    enabled: (force || COMPOSER_AGENT_ONLY_LAYOUT) && !projectBound,
    projectBound,
  };
};

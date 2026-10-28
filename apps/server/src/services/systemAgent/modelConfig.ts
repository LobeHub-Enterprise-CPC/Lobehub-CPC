import { DEFAULT_SYSTEM_AGENT_CONFIG } from '@lobechat/const';
import type { SystemAgentItem, UserSystemAgentConfigKey } from '@lobechat/types';

import { getServerSystemModels } from '@/server/globalConfig/systemModels';

interface ResolveSystemAgentModelConfigParams {
  override?: Partial<Pick<SystemAgentItem, 'model' | 'provider'>>;
  /** The user's own setting for the task. */
  taskConfig?: Partial<SystemAgentItem>;
  taskKey: UserSystemAgentConfigKey;
}

/**
 * Model for a server-run system task: explicit override > the user's setting >
 * the deployment's system agent (the tenant's `system_models` in business builds,
 * `SYSTEM_AGENT` otherwise) > code default.
 */
export const resolveSystemAgentModelConfig = async ({
  override,
  taskConfig,
  taskKey,
}: ResolveSystemAgentModelConfigParams): Promise<{ model: string; provider: string }> => {
  const defaults = DEFAULT_SYSTEM_AGENT_CONFIG[taskKey];
  const deployment = (await getServerSystemModels()).systemAgent[taskKey];
  const model = override?.model || taskConfig?.model || deployment?.model || defaults.model;
  const provider =
    override?.provider || taskConfig?.provider || deployment?.provider || defaults.provider;

  return { model, provider };
};

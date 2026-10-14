import { loadTenantSettings } from '@lobechat/business-config/tenant-settings';
import type { UserMemoryServiceModelConfigKey, UserServiceModelConfig } from '@lobechat/types';

import { getServerSystemModels } from '@/server/globalConfig/systemModels';

const MEMORY_SERVICE_SLOTS: UserMemoryServiceModelConfigKey[] = [
  'memoryAnalysisAgentConfig',
  'userMemoryEmbedding',
  'userMemoryPersonaWriter',
];

type MemoryServiceSlot = UserServiceModelConfig[UserMemoryServiceModelConfigKey];

const layerSlot = (
  deployment: MemoryServiceSlot | undefined,
  user: MemoryServiceSlot | undefined,
): MemoryServiceSlot | undefined => {
  if (!deployment) return user;
  if (!user) return deployment;

  // Model and provider travel as a pair: a user who picked no model keeps the deployment's.
  const model = user.model
    ? { model: user.model, provider: user.provider }
    : { model: deployment.model, provider: deployment.provider };

  return { ...deployment, ...user, ...model };
};

/**
 * Memory service model settings for a user. Business builds layer the user's own
 * settings over the tenant's `system_models` (spec FR-TS-03); other builds keep
 * the `MEMORY_USER_MEMORY_*` variables as the deployment layer, so only the
 * user's settings apply here. Memory agents fall back to the extraction config
 * for any slot left unset.
 */
export const resolveMemoryServiceModelConfig = async (
  userSystemAgent?: Partial<UserServiceModelConfig>,
): Promise<Partial<UserServiceModelConfig> | undefined> => {
  if (!(await loadTenantSettings())) return userSystemAgent;

  const { systemAgent: deployment } = await getServerSystemModels();
  const resolved: Partial<UserServiceModelConfig> = { ...userSystemAgent };

  for (const slot of MEMORY_SERVICE_SLOTS) {
    const value = layerSlot(deployment[slot], userSystemAgent?.[slot]);

    if (value) resolved[slot] = value;
  }

  return resolved;
};

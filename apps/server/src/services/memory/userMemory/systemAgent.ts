import { loadTenantSettings } from '@lobechat/business-config/tenant-settings';
import type { UserMemoryServiceModelConfigKey, UserServiceModelConfig } from '@lobechat/types';

import type { MemoryAgentConfig } from '@/server/globalConfig/parseMemoryExtractionConfig';
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

const normalizeProvider = (provider: string) => provider.toLowerCase();

/**
 * Layers one memory service slot of the resolved system agent config over the
 * extraction config fallback. The extractor and every user-memory embedding
 * call site share this so vectors are written and queried with the same model.
 */
export const resolveUserMemoryAgent = (
  systemAgent: Partial<UserServiceModelConfig> | undefined,
  key: UserMemoryServiceModelConfigKey,
  fallback: MemoryAgentConfig,
): MemoryAgentConfig => {
  const override = systemAgent?.[key];
  const provider = override?.provider || fallback.provider;
  const shouldInheritCredentials =
    !override?.provider ||
    normalizeProvider(override.provider) === normalizeProvider(fallback.provider || 'openai');
  const contextLimit =
    typeof override?.contextLimit === 'number' &&
    Number.isFinite(override.contextLimit) &&
    override.contextLimit > 0
      ? Math.floor(override.contextLimit)
      : fallback.contextLimit;

  return {
    apiKey: shouldInheritCredentials ? fallback.apiKey : undefined,
    baseURL: shouldInheritCredentials ? fallback.baseURL : undefined,
    contextLimit,
    language: fallback.language,
    model: override?.model || fallback.model,
    provider,
  };
};

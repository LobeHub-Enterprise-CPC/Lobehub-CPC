import {
  loadTenantSettings,
  type TenantSystemModels,
} from '@lobechat/business-config/tenant-settings';
import { ModelProvider } from 'model-bank';

import { DEFAULT_FILES_CONFIG } from '@/const/settings/knowledge';
import { appEnv } from '@/envs/app';
import { knowledgeEnv } from '@/envs/knowledge';
import {
  DEFAULT_MULTIMODAL_IMAGE_FORMATS,
  type MultimodalImageFormat,
  toolsEnv,
} from '@/envs/tools';
import { type SystemEmbeddingConfig } from '@/types/knowledgeBase';
import { type UserServiceModelConfig } from '@/types/user/settings';

import { parseFilesConfig } from './parseFilesConfig';
import {
  buildSystemAgentConfig,
  parseSystemAgent,
  type SystemAgentModelAssignment,
} from './parseSystemAgent';

export interface MultimodalUnderstandingModel {
  /** Image encodings the model accepts; other images are converted first. */
  imageFormats: MultimodalImageFormat[];
  model: string;
  provider: string;
}

/** Models the server picks for its own work, as configured for this deployment or tenant. */
export interface ServerSystemModels {
  /** Raw tenant fallback for system tasks without a named slot. */
  defaultModel?: SystemAgentModelAssignment;
  filesConfig: SystemEmbeddingConfig;
  /** Unset: the multimodal understanding capability is off. */
  multimodalUnderstanding?: MultimodalUnderstandingModel;
  /** Deployment layer of the system agent config, below the user's own settings. */
  systemAgent: Partial<UserServiceModelConfig>;
}

/**
 * Memory agents that run on a chat model. `SYSTEM_AGENT`'s `default` leaves them
 * to the `MEMORY_USER_MEMORY_*` variables, which business builds do not read
 * (spec FR-TS-04), so here the tenant's `default` fills them when they are not
 * set explicitly. The embedding slot still needs an embedding model of its own.
 */
const MEMORY_CHAT_SLOTS = ['memoryAnalysisAgentConfig', 'userMemoryPersonaWriter'] as const;

const fromTenant = ({
  fileEmbedding,
  multimodalUnderstanding,
  systemAgent = {},
}: TenantSystemModels): ServerSystemModels => {
  const provider = ModelProvider.LobeHub;

  const assignments: Record<string, SystemAgentModelAssignment> = {};
  for (const [slot, model] of Object.entries(systemAgent)) {
    if (model) assignments[slot] = { model, provider };
  }
  if (assignments.default) {
    for (const slot of MEMORY_CHAT_SLOTS) assignments[slot] ??= assignments.default;
  }

  return {
    defaultModel: assignments.default,
    filesConfig: fileEmbedding
      ? { ...DEFAULT_FILES_CONFIG, embeddingModel: { model: fileEmbedding, provider } }
      : DEFAULT_FILES_CONFIG,
    multimodalUnderstanding: multimodalUnderstanding
      ? {
          imageFormats: [...DEFAULT_MULTIMODAL_IMAGE_FORMATS],
          model: multimodalUnderstanding,
          provider,
        }
      : undefined,
    systemAgent: buildSystemAgentConfig(assignments),
  };
};

const fromEnv = (): ServerSystemModels => {
  const provider = toolsEnv.MULTIMODAL_UNDERSTANDING_PROVIDER;
  const model = toolsEnv.MULTIMODAL_UNDERSTANDING_MODEL;

  return {
    filesConfig: parseFilesConfig(knowledgeEnv.DEFAULT_FILES_CONFIG),
    multimodalUnderstanding:
      provider && model
        ? { imageFormats: toolsEnv.MULTIMODAL_UNDERSTANDING_IMAGE_FORMATS, model, provider }
        : undefined,
    systemAgent: parseSystemAgent(appEnv.SYSTEM_AGENT),
  };
};

/**
 * Business builds take these models from the current tenant's `system_models`
 * (spec FR-TS-03), always served by the `lobehub` provider, and read none of
 * `SYSTEM_AGENT`, `DEFAULT_FILES_CONFIG` or `MULTIMODAL_UNDERSTANDING_*`. Other
 * builds parse those environment variables.
 */
export const getServerSystemModels = async (): Promise<ServerSystemModels> => {
  const tenantSettings = await loadTenantSettings();

  return tenantSettings ? fromTenant(tenantSettings.systemModels) : fromEnv();
};

import { DEFAULT_SYSTEM_AGENT_CONFIG } from '@/const/settings';
import { type UserServiceModelConfig } from '@/types/user/settings';

const protectedKeys = Object.keys(DEFAULT_SYSTEM_AGENT_CONFIG);

const defaultTrueLey = new Set(['promptRewrite', 'autoSuggestion']);
const memoryServiceModelKeys = new Set([
  'memoryAnalysisAgentConfig',
  'userMemoryEmbedding',
  'userMemoryPersonaWriter',
]);
// `default` names a chat model; a speech-to-text slot must be set explicitly.
const nonChatModelKeys = new Set(['asr']);
const defaultModelAssignmentKeys = protectedKeys.filter(
  (key) => !memoryServiceModelKeys.has(key) && !nonChatModelKeys.has(key),
);

export interface SystemAgentModelAssignment {
  model: string;
  provider: string;
}

const toSlotConfig = (key: string, { model, provider }: SystemAgentModelAssignment) => ({
  enabled: defaultTrueLey.has(key) ? true : undefined,
  model,
  provider,
});

/**
 * Turns per-slot model assignments into a system agent config. Unknown slots are
 * ignored; `default` fills every chat slot left unassigned, but never the memory
 * service slots or speech-to-text.
 */
export const buildSystemAgentConfig = (
  assignments: Record<string, SystemAgentModelAssignment>,
): Partial<UserServiceModelConfig> => {
  const config: Partial<UserServiceModelConfig> = {};

  for (const [key, assignment] of Object.entries(assignments)) {
    if (key !== 'default' && protectedKeys.includes(key)) {
      config[key as keyof UserServiceModelConfig] = toSlotConfig(key, assignment) as any;
    }
  }

  const defaultSetting = assignments.default;

  if (defaultSetting) {
    for (const key of defaultModelAssignmentKeys) {
      if (!config[key as keyof UserServiceModelConfig]) {
        config[key as keyof UserServiceModelConfig] = toSlotConfig(key, defaultSetting) as any;
      }
    }
  }

  return config;
};

export const parseSystemAgent = (envString: string = ''): Partial<UserServiceModelConfig> => {
  if (!envString) return {};

  const assignments: Record<string, SystemAgentModelAssignment> = {};

  // Handle full-width commas and extra spaces
  const envValue = envString.replaceAll('，', ',').trim();

  const pairs = envValue.split(',');

  for (const pair of pairs) {
    const [key, value] = pair.split('=').map((s) => s.trim());

    if (key && value) {
      const [provider, ...modelParts] = value.split('/');
      const model = modelParts.join('/');

      if (!provider || !model) {
        throw new Error('Missing model or provider value');
      }

      assignments[key] = { model: model.trim(), provider: provider.trim() };
    } else {
      throw new Error('Invalid environment variable format');
    }
  }

  return buildSystemAgentConfig(assignments);
};

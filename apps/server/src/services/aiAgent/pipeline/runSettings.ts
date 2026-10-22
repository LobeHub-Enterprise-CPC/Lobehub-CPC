import debug from 'debug';

import type { AgentConfigWithId } from '@/server/services/agent';

import type { RunFacts } from '../runFacts';

const log = debug('lobe-server:ai-agent-service');

export interface RunSettingsInput {
  agentConfig: AgentConfigWithId;
  runFacts: RunFacts;
}

export interface RunSettings {
  enableExpertise: boolean;
  globalMemoryEnabled: boolean;
  userTimezone?: string;
}

/** Resolve the run's memory, expertise and timezone settings from the user's rows. */
export const resolveRunSettings = async ({
  agentConfig,
  runFacts,
}: RunSettingsInput): Promise<RunSettings> => {
  // Agent-level memory config takes priority; fallback to user-level setting
  const agentMemoryEnabled = agentConfig.chatConfig?.memory?.enabled;
  let globalMemoryEnabled = agentMemoryEnabled ?? false;
  let enableExpertise = false;
  let userTimezone: string | undefined;
  try {
    const settings = await runFacts.userSettings();
    const memorySettings = settings?.memory as { enabled?: boolean } | undefined;

    globalMemoryEnabled = agentMemoryEnabled ?? memorySettings?.enabled !== false;

    const generalSettings = settings?.general as { timezone?: string } | undefined;
    userTimezone = generalSettings?.timezone;
  } catch (error) {
    log('execAgent: failed to fetch user settings: %O', error);
  }
  try {
    const preference = await runFacts.userPreference();
    enableExpertise = preference?.lab?.enableSelfLearning === true;
  } catch (error) {
    console.error('Failed to resolve expertise injection Lab preference:', error);
  }
  return { enableExpertise, globalMemoryEnabled, userTimezone };
};

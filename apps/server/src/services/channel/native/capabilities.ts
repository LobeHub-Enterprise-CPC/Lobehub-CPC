import type { ChannelMemberConfig } from '@lobechat/types';

import type { LobeChatDatabase } from '@/database/type';
import { AgentService } from '@/server/services/agent';

export interface ChannelNativeAvailability {
  agentId: string;
  model: string;
  provider: string;
}

/**
 * Availability check run before a queued job is claimed. Everything else —
 * agent configuration, tool discovery, skills, memory, permissions — is
 * resolved by `execAgent` itself when the run starts, exactly as in chat.
 */
export async function checkChannelNativeAvailability(
  db: LobeChatDatabase,
  ownerId: string,
  config: ChannelMemberConfig,
): Promise<ChannelNativeAvailability> {
  if (!config.agentId) throw new Error('Native Channel members must reference an existing Agent');
  const agent = await new AgentService(db, ownerId).getAgentConfig(config.agentId);
  if (!agent) throw new Error('Native agent is no longer accessible');
  if (agent.agencyConfig?.heterogeneousProvider)
    throw new Error('Channel Agent runtime has changed');
  // The membership snapshot is display data, not an override of the current Agent.
  if (!agent.model || !agent.provider)
    throw new Error('Configure a model in this Agent before activating it');
  return { agentId: config.agentId, model: agent.model, provider: agent.provider };
}

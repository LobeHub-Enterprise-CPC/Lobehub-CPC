import { DEFAULT_TOOL_APPROVAL_MODE } from '@lobechat/business-const';
import type { ChannelMemberConfig, UserToolConfig } from '@lobechat/types';

import { UserModel } from '@/database/models/user';
import type { LobeChatDatabase } from '@/database/type';
import { getAgentRuntimeRedisClient } from '@/server/modules/AgentRuntime/redis';
import { AgentService } from '@/server/services/agent';
import { isQueueAgentRuntimeEnabled } from '@/server/services/queue/impls';

/** Availability only. execAgent owns configuration, tools, skills, memory and permissions. */
export async function loadChannelNativeCapabilities(
  db: LobeChatDatabase,
  ownerId: string,
  config: ChannelMemberConfig,
) {
  if (!config.agentId) throw new Error('Native Channel members must reference an existing Agent');
  const agent = await new AgentService(db, ownerId).getAgentConfig(config.agentId);
  if (!agent) throw new Error('Native agent is no longer accessible');
  if (agent.agencyConfig?.heterogeneousProvider)
    throw new Error('Channel Agent runtime has changed');
  if (!agent.model || !agent.provider)
    throw new Error('Configure a model in this Agent before activating it');
  if (!isQueueAgentRuntimeEnabled() || !process.env.QSTASH_TOKEN || !getAgentRuntimeRedisClient())
    throw new Error(
      'Channel native execution requires the standard Redis/QStash Agent runtime (AGENT_RUNTIME_MODE=queue)',
    );
  const settings = await new UserModel(db, ownerId).getUserSettings();
  const intervention = (settings?.tool as UserToolConfig | undefined)?.humanIntervention;
  const approvalMode = intervention?.approvalMode;
  return {
    userInterventionConfig: {
      approvalMode:
        approvalMode === 'headless'
          ? ('auto-run' as const)
          : approvalMode || DEFAULT_TOOL_APPROVAL_MODE,
      allowList: intervention?.allowList || [],
    },
  };
}

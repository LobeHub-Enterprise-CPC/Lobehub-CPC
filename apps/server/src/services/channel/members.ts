import { INBOX_SESSION_ID } from '@lobechat/const';
import {
  agentDisplayName,
  type ChannelMemberConfig,
  type ChannelRuntime,
  type HeterogeneousProviderConfig,
  isChannelRuntime,
} from '@lobechat/types';
import { TRPCError } from '@trpc/server';

import { AgentModel } from '@/database/models/agent';
import type { LobeChatDatabase } from '@/database/type';
import { AgentService } from '@/server/services/agent';

export interface ChannelAgentSelection {
  agentId: string;
  deviceId?: string;
  workingDirectory?: string;
}

async function getChannelAgent(db: LobeChatDatabase, ownerId: string, agentId: string) {
  const agent = await new AgentModel(db, ownerId).getAgentConfigById(agentId);
  if (!agent || agent.agencyConfig?.heterogeneousProvider) return agent;
  // Every native Agent may store sparse config; use standalone defaults for all of them.
  const configured = await new AgentService(db, ownerId).getAgentConfigById(agentId);
  return configured ? { ...agent, ...configured } : null;
}

/** Resolve launch-only configuration without copying credentials into durable Channel membership. */
export async function resolveChannelMemberRuntime(
  db: LobeChatDatabase,
  ownerId: string,
  agentId: string,
  expectedRuntime: ChannelRuntime,
): Promise<{ provider?: HeterogeneousProviderConfig; systemRole: string }> {
  const agent = await getChannelAgent(db, ownerId, agentId);
  if (!agent || (agent.virtual && agent.slug !== INBOX_SESSION_ID))
    throw new Error('Channel Agent is no longer accessible');
  const provider = agent.agencyConfig?.heterogeneousProvider;
  const runtime = provider?.type ?? 'native';
  if (!isChannelRuntime(runtime) || runtime !== expectedRuntime)
    throw new Error('Channel Agent runtime has changed');
  return {
    provider,
    // Match standalone execution: heterogeneous agents do not consume the native prompt editor.
    systemRole: (provider ? provider.systemContext : agent.systemRole) || '',
  };
}

/** Membership references an owned Agent. The caller cannot replace its identity or runtime. */
export async function resolveChannelMembers(
  db: LobeChatDatabase,
  ownerId: string,
  selections: ChannelAgentSelection[],
) {
  if (new Set(selections.map((item) => item.agentId)).size !== selections.length)
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'This Agent is already selected' });
  return Promise.all(
    selections.map(async (selection) => {
      const agent = await getChannelAgent(db, ownerId, selection.agentId);
      if (!agent || (agent.virtual && agent.slug !== INBOX_SESSION_ID))
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Agent is no longer accessible' });
      const hetero = agent.agencyConfig?.heterogeneousProvider;
      if (hetero && !isChannelRuntime(hetero.type))
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'This Agent runtime is not supported in Channel yet',
        });
      if (!hetero && (!agent.model || !agent.provider))
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Configure a model in this Agent before joining a Channel',
        });
      // Execution environments belong to this membership, not the Agent's standalone binding.
      const config: ChannelMemberConfig = {
        agentId: agent.id,
        avatar: agent.avatar || undefined,
        backgroundColor: agent.backgroundColor || undefined,
        runtime: hetero ? (hetero.type as ChannelMemberConfig['runtime']) : 'native',
        model: hetero ? hetero.model || '' : agent.model!,
        provider: hetero ? hetero.type : agent.provider!,
        systemRole: (hetero ? hetero.systemContext : agent.systemRole) || '',
        deviceId: selection.deviceId,
        workingDirectory: selection.workingDirectory,
      };
      return {
        name: agentDisplayName(agent, agent.id),
        description: agent.description || '',
        config,
      };
    }),
  );
}

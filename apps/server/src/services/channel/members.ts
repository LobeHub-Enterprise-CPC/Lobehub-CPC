import { agentDisplayName, type ChannelMemberConfig } from '@lobechat/types';
import { TRPCError } from '@trpc/server';

import { AgentModel } from '@/database/models/agent';
import type { LobeChatDatabase } from '@/database/type';

export interface ChannelAgentSelection {
  agentId: string;
  deviceId?: string;
  workingDirectory?: string;
}

/** Membership references an owned Agent. The caller cannot replace its identity or runtime. */
export async function resolveChannelMembers(
  db: LobeChatDatabase,
  ownerId: string,
  selections: ChannelAgentSelection[],
) {
  if (new Set(selections.map((item) => item.agentId)).size !== selections.length)
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'This Agent is already selected' });
  const model = new AgentModel(db, ownerId);
  return Promise.all(
    selections.map(async (selection) => {
      const agent = await model.getAgentConfigById(selection.agentId);
      if (!agent || agent.virtual)
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Agent is no longer accessible' });
      const hetero = agent.agencyConfig?.heterogeneousProvider;
      if (hetero && !['codex', 'amp', 'grok-build'].includes(hetero.type))
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'This Agent runtime is not supported in Channel yet',
        });
      if (
        hetero &&
        ((hetero.command &&
          hetero.command !== (hetero.type === 'grok-build' ? 'grok' : hetero.type)) ||
          hetero.args?.length ||
          Object.keys(hetero.env || {}).length ||
          hetero.authMode === 'api' ||
          (hetero.effort && hetero.effort !== 'default') ||
          (hetero.speed && hetero.speed !== 'default'))
      )
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'This Agent uses settings that do not yet have a Channel adapter',
        });
      if (!hetero && (!agent.model || !agent.provider))
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Configure a model in this Agent before joining a Channel',
        });
      if (
        hetero &&
        agent.agencyConfig?.executionTarget === 'device' &&
        agent.agencyConfig.boundDeviceId !== selection.deviceId
      )
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Select the device already bound to this Agent',
        });
      const config: ChannelMemberConfig = {
        agentId: agent.id,
        avatar: agent.avatar || undefined,
        backgroundColor: agent.backgroundColor || undefined,
        runtime: hetero ? (hetero.type as ChannelMemberConfig['runtime']) : 'native',
        model: hetero ? hetero.model || '' : agent.model!,
        provider: hetero ? hetero.type : agent.provider!,
        systemRole: [agent.systemRole, hetero?.systemContext].filter(Boolean).join('\n\n'),
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

import type { ContextBuilder } from '@lobechat/agent-runtime';
import { countContextTokens } from '@lobechat/context-engine';
import type { UIChatMessage } from '@lobechat/types';

import { ServerContextBuilder } from '@/server/modules/AgentRuntime/adapters/ServerContextBuilder';
import type { RuntimeContextBuilderContext } from '@/server/modules/AgentRuntime/context';

/** Ordinary context engineering includes tool activation, skills, knowledge and model search. */
export const createChannelAgentContextBuilder = (
  options: Omit<RuntimeContextBuilderContext, 'operationId' | 'stepIndex'> & {
    contextWindowTokens: number;
  },
): ContextBuilder => ({
  build: async (input) => {
    const builder = new ServerContextBuilder({
      ...options,
      operationId: input.state.operationId,
      stepIndex: input.state.stepCount,
      agentConfig: { ...options.agentConfig, systemRole: input.state.systemRole },
    });
    const result = await builder.build(input);
    const modelParameters = {
      ...options.agentConfig?.params,
      ...(result.modelParameters as object),
    };
    const accounting = countContextTokens({
      messages: result.messages as UIChatMessage[],
      tools: result.resolvedTools?.tools,
    });
    const outputReserve =
      typeof modelParameters.max_tokens === 'number' ? modelParameters.max_tokens : 4096;
    if (accounting.adjustedTotal + outputReserve > options.contextWindowTokens)
      throw new Error(
        'Channel context exceeds model capacity after compression. Reduce the material or rebuild a smaller discussion.',
      );
    return { ...result, modelParameters };
  },
});

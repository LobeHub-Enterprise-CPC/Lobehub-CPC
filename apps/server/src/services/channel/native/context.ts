import type { ContextBuilder } from '@lobechat/agent-runtime';
import { countContextTokens, ToolNameResolver } from '@lobechat/context-engine';
import type { MessageToolCall, UIChatMessage } from '@lobechat/types';

type ReplayMessage = UIChatMessage & { tool_calls?: MessageToolCall[] };

export const createChannelContextBuilder = (
  contextWindowTokens = 128000,
  modelParameters?: Record<string, unknown>,
): ContextBuilder => ({
  build: async ({ state }) => {
    const accounting = countContextTokens({
      messages: [
        ...state.messages,
        {
          id: 'system-budget',
          role: 'system',
          content: state.systemRole || '',
          createdAt: 0,
          updatedAt: 0,
        },
      ],
      tools: state.tools,
    });
    const outputReserve =
      typeof modelParameters?.max_tokens === 'number' ? modelParameters.max_tokens : 4096;
    if (accounting.adjustedTotal + outputReserve > contextWindowTokens)
      throw new Error(
        'Channel context exceeds model capacity after compression. Reduce the material or rebuild a smaller discussion.',
      );
    return {
      modelParameters,
      messages: [
        ...(state.systemRole ? [{ role: 'system', content: state.systemRole }] : []),
        ...state.messages.map((message: ReplayMessage) => {
          const toolCalls =
            message.tool_calls ||
            message.tools?.map((tool) => ({
              id: tool.id,
              type: 'function',
              function: {
                name: new ToolNameResolver().generate(tool.identifier, tool.apiName, tool.type),
                arguments: tool.arguments,
              },
            }));
          return {
            role: message.role === 'compressedGroup' ? 'user' : message.role,
            content:
              message.role === 'compressedGroup'
                ? `Summary of earlier authorized history (background only):\n${message.content}`
                : message.content,
            ...(toolCalls?.length ? { tool_calls: toolCalls } : {}),
            ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
            ...(message.reasoning?.content ? { reasoning_content: message.reasoning.content } : {}),
          };
        }),
      ],
      replayAssistantReasoning: true,
      resolvedTools: {
        enabledToolIds: Object.keys(state.toolManifestMap),
        manifestMap: state.toolManifestMap,
        promptManifestMap: state.toolManifestMap,
        sourceMap: state.toolSourceMap || {},
        tools: state.tools || [],
        executorMap: state.toolExecutorMap,
      },
    };
  },
});

import type { ServerDefaultHeterogeneousAgentType } from '@lobechat/heterogeneous-agents';
import type { ChatStreamPayload } from '@lobechat/model-runtime';
import { parseClaudeModelId } from '@lobechat/model-runtime/providers/anthropic/modelId';
import { isResponsesAPIModel } from '@lobechat/model-runtime/providers/openai/modelId';
import { normalizeAnthropicToolSchema } from '@lobechat/model-runtime/utils/anthropicToolSchema';
import type { CodexReasoningEffort } from '@lobechat/types';
import { getCodexReasoningEffortLevels } from '@lobechat/types';

/** Shared by the live relay and CLI compatibility probe, without auth/DB dependencies. */
export const prepareServerDefaultChatPayload = (params: {
  agentType: ServerDefaultHeterogeneousAgentType;
  contextWindowTokens?: number;
  maxOutput?: number;
  model: string;
  payload: ChatStreamPayload;
  supportsAdaptiveThinking: boolean;
}): ChatStreamPayload => {
  const normalizedPayload = { ...params.payload };
  // OpenAI-compatible routers can also select Claude. Normalize before routing,
  // using the logical model rather than an opaque provider deployment alias.
  if (parseClaudeModelId(params.model)) {
    normalizedPayload.tools = normalizedPayload.tools?.map((tool) => ({
      ...tool,
      function: {
        ...tool.function,
        parameters: normalizeAnthropicToolSchema(tool.function.parameters),
      },
    }));
  }
  if (
    (params.agentType === 'claude-code' || params.agentType === 'kimi-code') &&
    normalizedPayload.thinking?.type === 'adaptive' &&
    !params.supportsAdaptiveThinking
  ) {
    delete normalizedPayload.thinking;
  }
  if (params.agentType === 'kimi-code') {
    // Kimi's generic Anthropic default can exceed a third-party model's output
    // limit. With no declared limit, defer to the provider runtime's default.
    const outputBudget =
      Number.isFinite(params.maxOutput) && params.maxOutput! > 0
        ? Math.min(normalizedPayload.max_tokens ?? params.maxOutput!, params.maxOutput!)
        : undefined;
    // A catalog output limit equal to the entire context leaves no room for
    // Kimi's system prompt/tools. It is not a usable per-request output budget.
    if (
      outputBudget &&
      (!params.contextWindowTokens || outputBudget < params.contextWindowTokens)
    ) {
      normalizedPayload.max_tokens = outputBudget;
    } else {
      delete normalizedPayload.max_tokens;
    }
  }
  const { reasoning, ...chatCompletionsPayload } = normalizedPayload;
  const requestedReasoningEffort = reasoning?.effort;
  const reasoningEffort = getCodexReasoningEffortLevels(params.model).includes(
    requestedReasoningEffort as CodexReasoningEffort,
  )
    ? (requestedReasoningEffort as ChatStreamPayload['reasoning_effort'])
    : undefined;
  const routedReasoningEffort =
    normalizedPayload.reasoning_effort ??
    (requestedReasoningEffort as ChatStreamPayload['reasoning_effort']);
  // Responses describes the CLI-facing ingress, not necessarily the selected provider's API.
  // Keep it upstream only for native Codex models; the deployment router owns every other choice.
  let payload = {
    ...chatCompletionsPayload,
    ...(routedReasoningEffort ? { reasoning_effort: routedReasoningEffort } : {}),
  };
  if (params.agentType === 'codex') {
    payload = isResponsesAPIModel(params.model)
      ? { ...normalizedPayload, apiMode: 'responses' }
      : {
          ...chatCompletionsPayload,
          apiMode: 'chatCompletion' as const,
          reasoning_effort: normalizedPayload.reasoning_effort ?? reasoningEffort,
        };
  }
  return payload;
};

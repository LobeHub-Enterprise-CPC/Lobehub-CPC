import type {
  ContextBuilder,
  ContextBuildInput,
  ContextBuildOutput,
} from '@lobechat/agent-runtime';
import { pick } from 'es-toolkit';
import type { LLMParams } from 'model-bank';

import type { RuntimeContextBuilderContext } from '../context';
import { buildServerCallLlmContext } from './serverCallLlmContextBuilder';
import { resolveServerCallLlmTooling } from './serverCallLlmTooling';

export class ServerContextBuilder implements ContextBuilder {
  constructor(private readonly ctx: RuntimeContextBuilderContext) {}

  async build(input: ContextBuildInput): Promise<ContextBuildOutput> {
    const tooling = resolveServerCallLlmTooling(
      this.ctx,
      input.state,
      input.payload.allowedToolNames,
    );
    const resolveAttachments = this.ctx.messageModel?.resolveAttachments;
    const llmPayload = resolveAttachments
      ? { ...input.payload, messages: await resolveAttachments(input.payload.messages) }
      : input.payload;
    const result = await buildServerCallLlmContext({
      ctx: this.ctx,
      llmPayload,
      model: input.model,
      provider: input.provider,
      state: input.state,
      tooling,
    });

    return {
      messages: result.processedMessages,
      modelParameters: {
        ...pick<LLMParams, keyof LLMParams>(input.state.world?.agent?.params ?? {}, [
          'frequency_penalty',
          'max_tokens',
          'presence_penalty',
          'reasoning_effort',
          'temperature',
          'top_p',
        ]),
        ...result.resolvedExtendParams,
        ...(typeof result.stream === 'boolean' && { stream: result.stream }),
      },
      preserveThinking: result.preserveThinkingForPayload,
      replayAssistantReasoning: result.shouldReplayAssistantReasoning,
      resolvedTools: tooling.resolved,
    };
  }
}

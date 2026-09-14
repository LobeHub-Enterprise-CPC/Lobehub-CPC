import type { LLMAttemptOutput, LLMTransport } from '@lobechat/agent-runtime';
import { ToolNameResolver } from '@lobechat/context-engine';
import type { ChatStreamPayload } from '@lobechat/model-runtime';
import { consumeStreamUntilDone } from '@lobechat/model-runtime';

import type { LobeChatDatabase } from '@/database/type';
import { initModelRuntimeFromDB } from '@/server/modules/ModelRuntime';

import type { ChannelBudget } from '../budget';

/** Reuses the model runtime and stream decoder while keeping Channel IO independent. */
export const createChannelLLMTransport = (
  db: LobeChatDatabase,
  ownerId: string,
  budget: ChannelBudget,
  signal: AbortSignal,
  onActivity?: (state: 'running' | 'typing') => Promise<void>,
): LLMTransport => ({
  retryPolicy: {
    classifyError: (error) => ({
      kind: 'stop',
      message: error instanceof Error ? error.message : String(error),
    }),
    maxAttempts: () => 1,
    resolveRetryBudget: () => 0,
  },
  async stream(payload, handlers) {
    budget.modelCall();
    await onActivity?.('running');
    let typing = false;
    const runtime = await initModelRuntimeFromDB(db, ownerId, payload.provider);
    let content = '';
    let error: unknown;
    const response = await runtime.chat(payload as ChatStreamPayload, {
      signal,
      user: ownerId,
      callback: {
        onText: async (text) => {
          if (text && !typing) {
            typing = true;
            await onActivity?.('typing');
          }
          content += text;
          handlers?.onText?.(text);
        },
        onError: async (e) => {
          error = e;
        },
      },
    });
    await consumeStreamUntilDone(response);
    signal.throwIfAborted();
    if (error) throw new Error('Channel model stream failed');
    return { content };
  },
  async runAttempt(input) {
    budget.modelCall();
    await onActivity?.('running');
    let typing = false;
    const output: LLMAttemptOutput = {
      answerSalvagedFromReasoning: false,
      content: '',
      contentParts: [],
      grounding: null,
      hasContentImages: false,
      hasReasoningImages: false,
      imageList: [],
      reasoningParts: [],
      thinkingContent: '',
      toolCalls: [],
      toolsCalling: [],
    };
    try {
      const runtime = await initModelRuntimeFromDB(db, ownerId, input.provider);
      let streamError: unknown;
      const response = await runtime.chat(
        {
          model: input.model,
          messages: input.context.messages,
          tools: input.context.resolvedTools?.tools ?? input.state.tools,
          stream: true,
          ...(typeof input.context.modelParameters === 'object' &&
          input.context.modelParameters !== null
            ? input.context.modelParameters
            : {}),
          ...(typeof input.context.preserveThinking === 'boolean' && {
            preserveThinking: input.context.preserveThinking,
          }),
        } as ChatStreamPayload,
        {
          signal,
          user: ownerId,
          callback: {
            onText: async (text) => {
              if (text && !typing) {
                typing = true;
                await onActivity?.('typing');
              }
              input.onFirstChunk?.();
              output.content += text;
            },
            onThinking: async (text) => {
              output.thinkingContent += text;
            },
            onCompletion: async (data) => {
              output.usage = data.usage;
              output.speed = data.speed;
              output.finishReason = data.finishReason;
              output.reasoning = data.reasoning;
            },
            onError: async (error) => {
              streamError = error;
            },
            onToolsCalling: async ({ toolsCalling }) => {
              output.toolCalls = toolsCalling;
              output.toolsCalling = new ToolNameResolver().resolve(
                toolsCalling,
                input.context.resolvedTools?.manifestMap ?? input.state.toolManifestMap,
                (input.context.resolvedTools?.tools ?? input.state.tools ?? []).map(
                  (tool) => tool.function.name,
                ),
              );
            },
          },
        },
      );
      await consumeStreamUntilDone(response);
      signal.throwIfAborted();
      if (streamError) throw new Error('Channel model stream failed');
      if (!output.content && !output.toolsCalling.length)
        throw new Error('Channel model returned no answer or tool call');
      return { ok: true, output };
    } catch (error) {
      return { ok: false, error, output };
    }
  },
});

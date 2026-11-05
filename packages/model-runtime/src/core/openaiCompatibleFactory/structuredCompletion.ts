import type OpenAI from 'openai';

import type { GenerateObjectOptions } from '../../types';
import { convertOpenAIUsage } from '../usageConverters/openai';

/**
 * Assembles a streamed Chat Completion back into the non-streaming shape the structured-output
 * paths read: the message content, the tool calls with their argument fragments joined, and the
 * usage the final chunk carries (`stream_options.include_usage`).
 */
const collectChatCompletionStream = async (
  stream: AsyncIterable<OpenAI.ChatCompletionChunk>,
): Promise<OpenAI.ChatCompletion> => {
  let content = '';
  const toolCalls: OpenAI.ChatCompletionMessageFunctionToolCall[] = [];
  let usage: OpenAI.CompletionUsage | undefined;

  for await (const chunk of stream) {
    if (chunk.usage) usage = chunk.usage;
    const delta = chunk.choices?.[0]?.delta;
    if (!delta) continue;
    if (delta.content) content += delta.content;
    for (const call of delta.tool_calls ?? []) {
      const slot = (toolCalls[call.index] ??= {
        function: { arguments: '', name: '' },
        id: '',
        type: 'function',
      });
      if (call.id) slot.id = call.id;
      if (call.function?.name) slot.function.name += call.function.name;
      if (call.function?.arguments) slot.function.arguments += call.function.arguments;
    }
  }

  const calls = toolCalls.filter(Boolean);
  return {
    choices: [
      {
        finish_reason: 'stop',
        index: 0,
        logprobs: null,
        message: {
          content: content || null,
          refusal: null,
          role: 'assistant',
          ...(calls.length ? { tool_calls: calls } : {}),
        },
      },
    ],
    created: 0,
    id: '',
    model: '',
    object: 'chat.completion',
    usage,
  };
};

/**
 * Sends a structured-output Chat Completions request and reports its usage. With `stream`, the
 * reply is streamed and assembled here: gateways close a connection that stays idle past their
 * read timeout (e.g. nginx after 900s), which a slow model generating a large object hits before
 * it sends its first byte; a stream keeps the connection busy while the model writes.
 */
export const createStructuredCompletion = async (
  client: Pick<OpenAI, 'chat'>,
  request: OpenAI.ChatCompletionCreateParamsNonStreaming,
  options: (GenerateObjectOptions & { stream?: boolean }) | undefined,
  usagePayload: Parameters<typeof convertOpenAIUsage>[1],
): Promise<OpenAI.ChatCompletion> => {
  const requestOptions = { headers: options?.headers, signal: options?.signal };
  const res = options?.stream
    ? await collectChatCompletionStream(
        await client.chat.completions.create(
          { ...request, stream: true, stream_options: { include_usage: true } },
          requestOptions,
        ),
      )
    : await client.chat.completions.create(request, requestOptions);

  if (res.usage) await options?.onUsage?.(convertOpenAIUsage(res.usage, usagePayload));

  return res;
};

// @vitest-environment node
import { AgentRuntime, type AgentState, type LLMAttemptInput } from '@lobechat/agent-runtime';
import type * as ModelRuntimeModule from '@lobechat/model-runtime';
import { expect, it, vi } from 'vitest';

import type { LobeChatDatabase } from '@/database/type';

import { ChannelBudget } from '../budget';
import { createChannelLLMTransport } from './llm';

const { chat } = vi.hoisted(() => ({ chat: vi.fn() }));
vi.mock('@/server/modules/ModelRuntime', () => ({
  initModelRuntimeFromDB: vi.fn().mockResolvedValue({ chat }),
}));
vi.mock('@lobechat/model-runtime', async (original) => ({
  ...(await original<typeof ModelRuntimeModule>()),
  consumeStreamUntilDone: vi.fn(),
}));

it('sends resolved tools and model search/thinking settings instead of stale initial tools', async () => {
  chat.mockImplementation(async (_payload, options) => {
    await options.callback.onText('Search complete');
    return new Response();
  });
  const tools: NonNullable<AgentState['tools']> = [
    { type: 'function', function: { name: 'fresh____search____builtin', parameters: {} } },
  ];
  const transport = createChannelLLMTransport(
    {} as LobeChatDatabase,
    'owner',
    new ChannelBudget(),
    new AbortController().signal,
  );
  const result = await transport.runAttempt!({
    state: AgentRuntime.createInitialState({ operationId: 'run', tools: [] }),
    model: 'search-model',
    provider: 'search-provider',
    context: {
      messages: [{ role: 'user', content: 'News' }],
      replayAssistantReasoning: true,
      modelParameters: { enabledSearch: true, temperature: 0.3 },
      preserveThinking: true,
      resolvedTools: {
        tools,
        enabledToolIds: ['fresh'],
        manifestMap: {},
        promptManifestMap: {},
        sourceMap: {},
        executorMap: {},
      },
    },
  } as LLMAttemptInput);
  expect(result.ok).toBe(true);
  expect(chat).toHaveBeenCalledWith(
    expect.objectContaining({
      tools,
      enabledSearch: true,
      preserveThinking: true,
      temperature: 0.3,
    }),
    expect.anything(),
  );
});

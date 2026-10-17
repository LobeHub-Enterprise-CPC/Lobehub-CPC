// @vitest-environment node
import type { AgentState, ContextBuildInput, LLMAttemptInput } from '@lobechat/agent-runtime';
import { resolveAgentConfig } from '@lobechat/mecha';
import { ModelRuntime } from '@lobechat/model-runtime';
import { CreateAgentSchema, type LobeAgentConfig } from '@lobechat/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { initModelRuntimeFromDB } from '@/server/modules/ModelRuntime';

import type { RuntimeExecutorContext } from '../context';
import { ServerContextBuilder } from './ServerContextBuilder';
import { ServerLLMTransport } from './ServerLLMTransport';

// Only external model/DB selection is isolated. Resolver, tooling, context
// engine, hints, builder, and final transport payload assembly all run for real.
vi.mock('@/server/modules/ModelRuntime', () => ({
  initModelRuntimeFromDB: vi.fn(),
  resolveServerModel: vi.fn(),
}));
vi.mock('../llmRelay/resolveLlmExecutionSite', () => ({
  resolveLlmExecutionSite: vi.fn(async () => ({ site: 'server' })),
}));
vi.mock('@/business/client/model-bank/loadModels', () => ({
  loadModels: vi.fn(() => {
    throw new Error('The frozen run must not read the live model bank');
  }),
}));

const createCtx = (reasoning = true): RuntimeExecutorContext =>
  ({
    messageModel: {},
    modelRuntimeConfig: {
      model: 'gpt-4',
      modelFacts: {
        cards: [
          {
            abilities: {},
            extendParams: reasoning ? ['reasoningEffort'] : [],
            id: 'gpt-4',
            providerId: 'openai',
          },
        ],
        model: 'gpt-4',
        provider: 'openai',
        reasoningConfig: { reasoningEffort: 'low' },
      },
      provider: 'openai',
    },
    operationId: 'operation-params',
    stepIndex: 0,
    stream: false,
    streamManager: {
      publishStreamChunk: vi.fn().mockResolvedValue('chunk-id'),
      publishStreamEvent: vi.fn().mockResolvedValue('event-id'),
    },
    toolExecutionService: {},
    userId: 'user-params',
    // No serverDB: real fact providers cannot query an external database.
  }) as unknown as RuntimeExecutorContext;

const prepareAndCapture = async (stored: LobeAgentConfig, reasoning = true) => {
  const storedBefore = structuredClone(stored);
  const resolved = resolveAgentConfig(
    { agentId: 'agent-params' },
    { agentConfig: stored, canManage: true, chatConfig: stored.chatConfig! },
  );
  // Production resolveRunAgentConfig applies the same shared result before
  // startOperation/createOperation freezes it into world.agent.
  const agent = Object.freeze({ ...resolved.agentConfig, chatConfig: resolved.chatConfig });
  const state = {
    metadata: {},
    world: Object.freeze({ agent }),
  } as unknown as AgentState;
  const worldBefore = structuredClone(state.world);
  const ctx = Object.freeze(createCtx(reasoning));
  const context = await new ServerContextBuilder(ctx).build({
    model: 'gpt-4',
    payload: { messages: [{ content: 'Question', id: 'user-message', role: 'user' }] },
    provider: 'openai',
    state,
  } as ContextBuildInput);
  const chat = vi.fn().mockImplementation(async () => new Response(''));
  vi.mocked(initModelRuntimeFromDB).mockImplementation(async () => new ModelRuntime({ chat }));
  await new ServerLLMTransport(ctx).runAttempt({
    assistantMessageId: 'assistant-message',
    attempt: 1,
    context,
    events: [],
    maxAttempts: 1,
    model: 'gpt-4',
    provider: 'openai',
    state,
  } as LLMAttemptInput);
  expect(chat).toHaveBeenCalledOnce();
  expect(stored).toEqual(storedBefore);
  expect(state.world).toEqual(worldBefore);
  expect(ctx.stream).toBe(false);
  const payload = chat.mock.calls[0][0] as Record<string, unknown>;
  expect({
    messages: payload.messages,
    model: payload.model,
    stream: payload.stream,
    tools: payload.tools,
  }).toEqual({ messages: context.messages, model: 'gpt-4', stream: false, tools: undefined });
  return payload;
};

describe('ServerContextBuilder frozen base params reach the actual model payload', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([512, 1024])(
    'preserves enabled max_tokens=%i and ordinary sampling params',
    async (maxTokens) => {
      const payload = await prepareAndCapture({
        chatConfig: { enableMaxTokens: true, enableReasoningEffort: true, stream: true },
        model: 'gpt-4',
        params: {
          frequency_penalty: 0.4,
          max_tokens: maxTokens,
          presence_penalty: 0.3,
          reasoning_effort: 'high',
          temperature: 0.2,
          top_p: 0.8,
        },
        plugins: [],
        provider: 'openai',
        systemRole: '',
      } as LobeAgentConfig);
      expect(payload).toMatchObject({
        frequency_penalty: 0.4,
        max_tokens: maxTokens,
        presence_penalty: 0.3,
        // Real frozen extend params win over the base value above.
        reasoning_effort: 'low',
        stream: false,
        temperature: 0.2,
        top_p: 0.8,
      });
    },
  );

  it('keeps disabled max tokens and reasoning residuals out of the request', async () => {
    const payload = await prepareAndCapture(
      {
        chatConfig: { enableMaxTokens: false, enableReasoningEffort: false },
        model: 'gpt-4',
        params: { max_tokens: 512, reasoning_effort: 'high', temperature: 0.6 },
        provider: 'openai',
        systemRole: '',
      } as LobeAgentConfig,
      false,
    );
    expect(payload.max_tokens).toBeUndefined();
    expect(payload.reasoning_effort).toBeUndefined();
    expect(payload.temperature).toBe(0.6);
  });

  it('accepts an older snapshot without base params', async () => {
    const payload = await prepareAndCapture(
      {
        chatConfig: {},
        model: 'gpt-4',
        provider: 'openai',
        systemRole: '',
      } as LobeAgentConfig,
      false,
    );
    expect(payload.max_tokens).toBeUndefined();
    expect(payload.stream).toBe(false);
  });

  it('projects schema-accepted params without replacing frozen request structure', async () => {
    const params = {
      deploymentName: 'untrusted-deployment',
      max_tokens: 512,
      messages: [{ content: 'untrusted-context', role: 'user' }],
      model: 'other-model',
      provider: 'other-provider',
      stream: true,
      temperature: 0.4,
      tool_choice: 'none',
      tools: [{ function: { name: 'untrusted-tool' }, type: 'function' }],
      unknownModelParameter: 'untrusted-extra',
    };
    // The formal API schema really accepts unknown keys; TypeScript alone
    // cannot establish that stored params contain only LLMParams.
    const stored = CreateAgentSchema.parse({
      chatConfig: { enableMaxTokens: true },
      model: 'gpt-4',
      params,
      provider: 'openai',
      systemRole: '',
    });
    expect(stored.params).toEqual(params);
    const payload = await prepareAndCapture(stored as LobeAgentConfig, false);
    expect(payload).toMatchObject({ max_tokens: 512, temperature: 0.4 });
    // These are not transport fields for this frozen OpenAI request. A
    // blacklist of only model/messages/tools would still forward them.
    expect(payload).not.toHaveProperty('deploymentName');
    expect(payload).not.toHaveProperty('provider');
    expect(payload).not.toHaveProperty('tool_choice');
    expect(payload).not.toHaveProperty('unknownModelParameter');
  });

  it('retains all six legal fields including zero-valued numeric params', async () => {
    const payload = await prepareAndCapture(
      {
        chatConfig: { enableMaxTokens: true, enableReasoningEffort: true },
        model: 'gpt-4',
        params: {
          frequency_penalty: 0,
          max_tokens: 0,
          presence_penalty: 0,
          reasoning_effort: 'none',
          temperature: 0,
          top_p: 0,
        },
        provider: 'openai',
        systemRole: '',
      } as LobeAgentConfig,
      false,
    );
    expect(payload).toMatchObject({
      frequency_penalty: 0,
      max_tokens: 0,
      presence_penalty: 0,
      reasoning_effort: 'none',
      temperature: 0,
      top_p: 0,
    });
  });
});

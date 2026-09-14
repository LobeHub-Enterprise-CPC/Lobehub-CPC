// @vitest-environment node
import { AgentRuntime } from '@lobechat/agent-runtime';
import type { LobeToolManifest } from '@lobechat/context-engine';
import { describe, expect, it, vi } from 'vitest';

import type { LobeChatDatabase } from '@/database/type';

import { createChannelAgentContextBuilder } from './agentContext';

const { build } = vi.hoisted(() => ({ build: vi.fn() }));
vi.mock('@/server/modules/AgentRuntime/adapters/serverCallLlmContextBuilder', () => ({
  buildServerCallLlmContext: build,
}));

describe('Channel context uses ordinary per-step tool resolution', () => {
  it('carries newly activated tools, Channel instructions and model search parameters into the next call', async () => {
    const manifest: LobeToolManifest = {
      identifier: 'discovered-tool',
      type: 'mcp',
      meta: { title: 'Discovered tool' },
      api: [
        { name: 'lookup', description: 'Lookup', parameters: { type: 'object', properties: {} } },
      ],
    };
    const state = AgentRuntime.createInitialState({
      operationId: 'channel-run',
      systemRole: 'Agent persona\nChannel author and thread instructions',
      world: {
        agent: { systemRole: 'Agent persona', params: { temperature: 0.4 } },
        userTimezone: 'Asia/Shanghai',
        connectorOwnershipNote: 'Connector belongs to the owner',
        projectInstructions: [{ source: 'AGENTS.md', content: 'Use the project convention' }],
      },
      tools: [],
      toolManifestMap: { 'discovered-tool': manifest },
      operationToolSet: {
        tools: [],
        enabledToolIds: [],
        manifestMap: { 'discovered-tool': manifest },
        executorMap: {},
        sourceMap: { 'discovered-tool': 'mcp' },
      },
      activatedStepTools: [
        { id: 'discovered-tool', manifest, source: 'discovery', activatedAtStep: 1 },
      ],
    });
    build.mockResolvedValue({
      processedMessages: [{ role: 'user', content: 'Find current news' }],
      resolvedExtendParams: { enabledSearch: true },
      shouldReplayAssistantReasoning: true,
      preserveThinkingForPayload: true,
    });
    const context = createChannelAgentContextBuilder({
      serverDB: {} as LobeChatDatabase,
      userId: 'owner',
      contextWindowTokens: 128000,
    });
    const result = await context.build({
      state,
      model: 'gpt-4o',
      provider: 'openai',
      payload: { messages: [], model: 'gpt-4o', provider: 'openai', tools: [] },
    });
    expect(result.resolvedTools?.enabledToolIds).toEqual(['discovered-tool']);
    expect(result.resolvedTools?.tools[0].function.name).toContain('lookup');
    expect(result.resolvedTools?.sourceMap['discovered-tool']).toBe('mcp');
    expect(result.modelParameters).toEqual({ enabledSearch: true, temperature: 0.4 });
    expect(result.preserveThinking).toBe(true);
    expect(build).toHaveBeenCalledWith(
      expect.objectContaining({
        state: expect.objectContaining({
          world: expect.objectContaining({
            userTimezone: 'Asia/Shanghai',
            agent: expect.objectContaining({ systemRole: state.systemRole }),
            connectorOwnershipNote: 'Connector belongs to the owner',
            projectInstructions: [{ source: 'AGENTS.md', content: 'Use the project convention' }],
          }),
        }),
      }),
    );
    expect(state.world?.agent?.systemRole).toBe('Agent persona');
  });
});

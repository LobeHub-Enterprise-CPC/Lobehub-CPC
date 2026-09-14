// @vitest-environment node
import { AgentRuntime, type ToolRunContext } from '@lobechat/agent-runtime';
import { DEFAULT_TOOL_APPROVAL_MODE } from '@lobechat/business-const';
import { DEFAULT_AGENT_CONFIG } from '@lobechat/const';
import type { ChannelMemberConfig } from '@lobechat/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { LobeChatDatabase } from '@/database/type';

import { loadChannelNativeCapabilities } from './capabilities';

const mocks = vi.hoisted(() => ({
  agent: vi.fn(),
  rawAgent: vi.fn(),
  plugins: vi.fn(),
  settings: vi.fn(),
  execute: vi.fn(),
  persona: vi.fn(),
}));
vi.mock('@/database/models/agent', () => ({
  AgentModel: class {
    getAgentConfigById = mocks.rawAgent;
  },
}));
vi.mock('@/server/services/agent', () => ({
  AgentService: class {
    getAgentConfig = mocks.agent;
  },
}));
vi.mock('@/database/models/user', () => ({
  UserModel: class {
    static getInfoForAIGeneration = vi.fn().mockResolvedValue({ responseLanguage: 'en-US' });
    getUserSettings = mocks.settings;
    getUserPreference = vi.fn().mockResolvedValue({});
  },
}));
vi.mock('@/database/models/userMemory/persona', () => ({
  UserPersonaModel: class {
    getLatestPersonaDocument = mocks.persona;
  },
}));
vi.mock('@/database/models/aiModel', () => ({
  AiModelModel: class {
    getModelListByProviderId = vi
      .fn()
      .mockResolvedValue([{ id: 'gpt-4o', contextWindowTokens: 128000 }]);
    findByIdAndProvider = vi.fn().mockResolvedValue({ contextWindowTokens: 128000 });
  },
}));
vi.mock('@/database/models/aiProvider', () => ({
  AiProviderModel: class {
    findById = vi.fn().mockResolvedValue(undefined);
  },
}));
vi.mock('@/database/models/plugin', () => ({
  PluginModel: class {
    query = mocks.plugins;
  },
}));
vi.mock('@/database/models/connector', () => ({
  ConnectorModel: class {
    resolveByIdentifiers = vi.fn().mockResolvedValue([]);
  },
}));
vi.mock('@/database/models/connectorTool', () => ({ ConnectorToolModel: class {} }));
vi.mock('@/database/models/message', () => ({ MessageModel: class {} }));
vi.mock('@/database/models/agentSkill', () => ({
  AgentSkillModel: class {
    findAll = vi.fn().mockResolvedValue({ data: [] });
    findByIds = vi.fn().mockResolvedValue([]);
  },
}));
vi.mock('@/server/services/agentDocuments', () => ({
  AgentDocumentsService: class {
    hasDocuments = vi.fn().mockResolvedValue(false);
    getAgentSkills = vi.fn().mockResolvedValue([]);
  },
}));
vi.mock('@/server/services/composio', () => ({
  ComposioService: class {
    getComposioManifests = vi.fn().mockResolvedValue([]);
  },
}));
vi.mock('@/server/services/market', () => ({
  MarketService: class {
    getLobehubSkillManifests = vi.fn().mockResolvedValue([]);
  },
}));
vi.mock('@/server/services/deviceGateway', () => ({ deviceGateway: { isConfigured: false } }));
vi.mock('@/server/services/connector/refresh', () => ({
  buildLastSyncedAtMap: vi.fn().mockReturnValue(new Map()),
  scheduleStaleConnectorToolsRefresh: vi.fn(),
}));
vi.mock('@/server/services/agentSignal/featureGate', () => ({
  isAgentSignalEnabledForUser: vi.fn().mockResolvedValue(false),
  isLobeAiAgentSlug: (slug: string) => slug === 'inbox',
  resolveAgentSelfIterationCapability: vi.fn().mockReturnValue(false),
}));
vi.mock('@/server/modules/KeyVaultsEncrypt', () => ({
  KeyVaultsGateKeeper: { initWithEnvKey: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('@/server/services/toolExecution/builtin', () => ({ BuiltinToolsExecutor: class {} }));
vi.mock('@/server/services/toolExecution', () => ({
  ToolExecutionService: class {
    executeTool = mocks.execute;
  },
}));
vi.mock('@/server/services/mcp', () => ({ mcpService: {} }));

const db = {} as LobeChatDatabase;
const member: ChannelMemberConfig = {
  agentId: 'native-agent',
  model: 'gpt-4o',
  provider: 'openai',
  runtime: 'native',
  systemRole: 'stale membership prompt',
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.rawAgent.mockResolvedValue({ id: member.agentId, plugins: null, chatConfig: null });
  mocks.agent.mockResolvedValue({
    ...structuredClone(DEFAULT_AGENT_CONFIG),
    id: member.agentId,
    userId: 'owner',
    model: 'gpt-4o',
    provider: 'openai',
    systemRole: 'Current agent instructions',
  });
  mocks.plugins.mockResolvedValue([]);
  mocks.persona.mockResolvedValue({
    persona: 'Prefers concise Chinese answers',
    tagline: 'Developer',
  });
  mocks.settings.mockResolvedValue({
    memory: { enabled: true },
    general: { timezone: 'Asia/Shanghai' },
  });
});

describe('Channel Native uses ordinary agent configuration and tool discovery', () => {
  it.each(['auto-run', 'manual', 'allow-list', 'headless'] as const)(
    'inherits the user approval preference (%s) and allow list',
    async (approvalMode) => {
      mocks.settings.mockResolvedValue({
        tool: { humanIntervention: { approvalMode, allowList: ['my-mcp/lookup'] } },
      });
      const result = await loadChannelNativeCapabilities(db, 'owner', member);
      expect(result.userInterventionConfig).toEqual({
        approvalMode: approvalMode === 'headless' ? 'auto-run' : approvalMode,
        allowList: ['my-mcp/lookup'],
      });
    },
  );

  it.each([undefined, {}, { tool: { humanIntervention: { allowList: ['my-mcp/lookup'] } } }])(
    'uses the distribution approval default when no mode is saved (%j)',
    async (settings) => {
      mocks.settings.mockResolvedValue(settings);
      const result = await loadChannelNativeCapabilities(db, 'owner', member);
      expect(result.userInterventionConfig).toEqual({
        approvalMode: DEFAULT_TOOL_APPROVAL_MODE,
        allowList: settings?.tool?.humanIntervention?.allowList ?? [],
      });
    },
  );

  it('inherits the ordinary memory snapshot and honors an Agent memory opt-out', async () => {
    const enabled = await loadChannelNativeCapabilities(db, 'owner', member);
    expect(enabled.runtimeContext?.world?.userMemory?.memories?.persona?.narrative).toBe(
      'Prefers concise Chinese answers',
    );
    const agent = await mocks.agent();
    mocks.agent.mockResolvedValue({
      ...agent,
      chatConfig: { ...agent.chatConfig, memory: { enabled: false } },
    });
    mocks.persona.mockClear();
    const disabled = await loadChannelNativeCapabilities(db, 'owner', member);
    expect(disabled.runtimeContext?.world?.userMemory).toBeUndefined();
    expect(disabled.enabledToolIds).not.toContain('lobe-user-memory');
    expect(mocks.persona).not.toHaveBeenCalled();
  });
  it.each([undefined, 'inbox'])(
    'enables default tools for a sparse agent (slug=%s)',
    async (slug) => {
      mocks.agent.mockResolvedValue({ ...(await mocks.agent()), slug });
      const result = await loadChannelNativeCapabilities(db, 'owner', member);
      expect(result.tools.some((t) => t.function.name.startsWith('lobe-web-browsing'))).toBe(true);
      expect(result.tools.some((t) => t.function.name.startsWith('lobe-skills'))).toBe(true);
      expect(result.systemRole).toBe(
        slug === 'inbox'
          ? 'Current agent instructions'
          : 'Current agent instructions\n\nPreferred reply language: en-US. Use this language unless the user explicitly asks to switch.',
      );
    },
  );

  it('honors search off and explicitly disabled plugins', async () => {
    const agent = await mocks.agent();
    mocks.agent.mockResolvedValue({
      ...agent,
      chatConfig: { ...agent.chatConfig, searchMode: 'off' },
      plugins: [{ identifier: 'lobe-user-memory', mode: 'disabled' }],
    });
    const result = await loadChannelNativeCapabilities(db, 'owner', member);
    expect(result.tools.some((t) => t.function.name.startsWith('lobe-web-browsing'))).toBe(false);
    expect(result.toolManifestMap).not.toHaveProperty('lobe-user-memory');
  });

  it('keeps explicitly configured executable Skills instead of rejecting the agent', async () => {
    mocks.rawAgent.mockResolvedValue({ id: member.agentId, plugins: ['lobe-skills'] });
    mocks.agent.mockResolvedValue({ ...(await mocks.agent()), plugins: ['lobe-skills'] });
    const result = await loadChannelNativeCapabilities(db, 'owner', member);
    expect(
      result.toolManifestMap['lobe-skills'].api.some(
        (api: { name: string }) => api.name === 'execScript',
      ),
    ).toBe(true);
  });

  it('uses the current model, parameters and prompt instead of the membership snapshot', async () => {
    const result = await loadChannelNativeCapabilities(db, 'owner', {
      ...member,
      model: 'retired-model',
      provider: 'retired-provider',
    });
    expect(result.modelRuntimeConfig).toEqual({ model: 'gpt-4o', provider: 'openai' });
    expect(result.modelParameters).toEqual(DEFAULT_AGENT_CONFIG.params);
    expect(result.systemRole).toBe(
      'Current agent instructions\n\nPreferred reply language: en-US. Use this language unless the user explicitly asks to switch.',
    );
    expect(mocks.agent).toHaveBeenCalledWith(member.agentId);
  });

  it('respects manual skill mode and chat mode without a Channel-specific tool preset', async () => {
    const agent = await mocks.agent();
    mocks.agent.mockResolvedValue({
      ...agent,
      chatConfig: { ...agent.chatConfig, skillActivateMode: 'manual' },
    });
    const manual = await loadChannelNativeCapabilities(db, 'owner', member);
    expect(manual.enabledToolIds).not.toContain('lobe-activator');
    expect(manual.enabledToolIds).toContain('lobe-web-browsing');
    mocks.agent.mockResolvedValue({
      ...agent,
      chatConfig: { ...agent.chatConfig, toolMode: 'chat', enableAgentMode: false },
    });
    const chat = await loadChannelNativeCapabilities(db, 'owner', member);
    expect(chat.enabledToolIds).not.toContain('lobe-skills');
    expect(chat.enabledToolIds).not.toContain('lobe-local-system');
  });

  it('keeps pinned MCP tools and forwards dynamic tool source and memory permissions to the normal executor', async () => {
    const agent = await mocks.agent();
    mocks.agent.mockResolvedValue({
      ...agent,
      plugins: ['my-mcp'],
      chatConfig: { ...agent.chatConfig, memory: { toolPermission: 'read-only' } },
    });
    const manifest = {
      identifier: 'my-mcp',
      type: 'mcp',
      meta: { title: 'My MCP' },
      api: [
        {
          name: 'lookup',
          description: 'Look up a value',
          parameters: { type: 'object', properties: {} },
        },
      ],
    };
    mocks.plugins.mockResolvedValue([
      {
        identifier: 'my-mcp',
        manifest,
        customParams: { mcp: { type: 'http', url: 'https://mcp.example.test' } },
      },
    ]);
    const result = await loadChannelNativeCapabilities(db, 'owner', member);
    expect(result.enabledToolIds).toContain('my-mcp');
    expect(result.toolManifestMap['my-mcp']).toMatchObject(manifest);
    const state = AgentRuntime.createInitialState({
      ...result.runtimeContext,
      operationId: 'channel-run',
      origin: { topicId: 'channel-session' },
      binding: { device: { id: 'late-bound-device', systemInfo: { workingDirectory: '/work' } } },
    });
    mocks.execute.mockResolvedValue({ success: true, content: 'Found' });
    await result.toolTransport!.run(
      { identifier: 'my-mcp', apiName: 'lookup', arguments: '{}', id: 'call', type: 'mcp' },
      {
        state,
        operationId: 'channel-run',
        effectiveManifestMap: result.toolManifestMap,
        parsedArgs: {},
        toolSource: 'plugin',
      } as ToolRunContext,
    );
    expect(mocks.execute).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'plugin' }),
      expect.objectContaining({
        agentId: member.agentId,
        userId: 'owner',
        memoryToolPermission: 'read-only',
        topicId: 'channel-session',
        workingDirectory: '/work',
        toolManifestMap: result.toolManifestMap,
      }),
    );
  });

  it('does not fall back to stale membership configuration for a removed or changed Agent', async () => {
    mocks.agent.mockResolvedValue(null);
    await expect(loadChannelNativeCapabilities(db, 'owner', member)).rejects.toThrow(
      'no longer accessible',
    );
    mocks.agent.mockResolvedValue({
      ...DEFAULT_AGENT_CONFIG,
      id: member.agentId,
      agencyConfig: { heterogeneousProvider: { type: 'codex' } },
    });
    await expect(loadChannelNativeCapabilities(db, 'owner', member)).rejects.toThrow(
      'runtime has changed',
    );
  });
});

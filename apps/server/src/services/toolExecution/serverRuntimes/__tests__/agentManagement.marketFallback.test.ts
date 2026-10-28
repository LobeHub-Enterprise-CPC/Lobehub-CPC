import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as ServableModels from '@/server/services/aiInfra/servableModels';

import { agentManagementRuntime } from '../agentManagement';

const {
  mockCountAgents,
  mockCreateAgent,
  mockGetAssistantList,
  mockGetAssistantDetail,
  mockQueryAgents,
  mockExistsById,
  mockGetAgentConfigById,
  mockServiceUpdateConfig,
  mockUpdateAgent,
  mockUpdateConfig,
  mockFindById,
  mockCreatePlugin,
  mockCreateAiInfraRepos,
  mockListServableChatProviders,
  mockGetMcpManifest,
  mockQueryPlugins,
  mockResolveConnectors,
  mockUpdatePlugin,
} = vi.hoisted(() => ({
  mockCountAgents: vi.fn(),
  mockCreateAgent: vi.fn(),
  mockCreateAiInfraRepos: vi.fn(),
  mockCreatePlugin: vi.fn(),
  mockFindById: vi.fn(),
  mockGetMcpManifest: vi.fn(),
  mockQueryPlugins: vi.fn(),
  mockResolveConnectors: vi.fn(),
  mockUpdatePlugin: vi.fn(),
  mockExistsById: vi.fn(),
  mockGetAgentConfigById: vi.fn(),
  mockGetAssistantList: vi.fn(),
  mockListServableChatProviders: vi.fn(),
  mockGetAssistantDetail: vi.fn(),
  mockQueryAgents: vi.fn(),
  mockServiceUpdateConfig: vi.fn(),
  mockUpdateAgent: vi.fn(),
  mockUpdateConfig: vi.fn(),
}));

vi.mock('@/server/services/agent', () => ({
  AgentService: vi.fn(function () {
    return { updateAgentConfig: mockServiceUpdateConfig };
  }),
}));

vi.mock('@/database/models/agent', () => ({
  AgentModel: vi.fn(function () {
    return {
      countAgents: mockCountAgents,
      create: mockCreateAgent,
      existsById: mockExistsById,
      getAgentConfigById: mockGetAgentConfigById,
      queryAgents: mockQueryAgents,
      update: mockUpdateAgent,
      updateConfig: mockUpdateConfig,
    };
  }),
}));

// Only the DB-touching half is stubbed — `validateServableModelSelection` runs
// for real, so these tests cover the wiring rather than restating the rules.
vi.mock('@/server/services/aiInfra/servableModels', async (importOriginal) => ({
  ...(await importOriginal<typeof ServableModels>()),
  createAiInfraRepos: mockCreateAiInfraRepos,
  listServableChatProviders: mockListServableChatProviders,
}));

vi.mock('@/database/models/plugin', () => ({
  PluginModel: vi.fn(function () {
    return {
      create: mockCreatePlugin,
      findById: mockFindById,
      query: mockQueryPlugins,
      update: mockUpdatePlugin,
    };
  }),
}));

vi.mock('@/database/models/connector', () => ({
  ConnectorModel: vi.fn(function () {
    return { resolveAll: mockResolveConnectors };
  }),
}));

vi.mock('@/server/services/discover', () => ({
  DiscoverService: vi.fn(function () {
    return {
      getAssistantDetail: mockGetAssistantDetail,
      getAssistantList: mockGetAssistantList,
      getMcpManifest: mockGetMcpManifest,
    };
  }),
}));

const createRuntime = () =>
  agentManagementRuntime.factory({
    serverDB: {} as never,
    toolManifestMap: {},
    userId: 'user-1',
  });

// Scenario tests split out of agentManagement.test.ts: that file crossed the
// 800-line limit when this scenario was added, and source-layout §3 requires the
// split here rather than leaving one over-limit test file.
describe('getAgentDetail market fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsById.mockResolvedValue(true);
    mockServiceUpdateConfig.mockImplementation((...args) => mockUpdateConfig(...args));
    mockResolveConnectors.mockResolvedValue([]);
    mockQueryPlugins.mockResolvedValue([]);
    mockGetMcpManifest.mockRejectedValue(new Error('not in marketplace'));
  });

  it('falls back to marketplace detail for a market-only agent', async () => {
    mockGetAgentConfigById.mockResolvedValue(null);
    mockGetAssistantDetail.mockResolvedValue({
      avatar: '🌐',
      backgroundColor: 'pink',
      config: {
        model: 'gpt-4o',
        openingMessage: 'Hi!',
        openingQuestions: ['Q1'],
        plugins: ['web-browsing', 'search'],
        provider: 'openai',
        systemRole: 'Market prompt',
      },
      description: 'A market agent',
      identifier: 'mkt12345',
      related: [],
      tags: ['ai'],
      title: 'Market Agent',
    });

    const runtime = createRuntime();
    const result = await runtime.getAgentDetail({ agentId: 'mkt12345' });

    expect(mockGetAssistantDetail).toHaveBeenCalledWith({
      identifier: 'mkt12345',
      source: 'new',
    });
    expect(result.success).toBe(true);
    expect(result.content).toContain('Market Agent');
    expect(result.content).toContain('Market prompt');
    expect(result.content).toContain('marketplace agent (read-only)');
    expect(result.state).toMatchObject({
      agentId: 'mkt12345',
      isMarket: true,
      config: expect.objectContaining({ model: 'gpt-4o', systemRole: 'Market prompt' }),
      meta: expect.objectContaining({ title: 'Market Agent' }),
    });
  });

  it('normalizes the object-shaped marketplace model before rendering', async () => {
    mockGetAgentConfigById.mockResolvedValue(null);
    mockGetAssistantDetail.mockResolvedValue({
      avatar: '🌐',
      config: {
        model: { model: 'gpt-4o', parameters: { temperature: 0.6 }, provider: 'openai' },
        plugins: ['web-browsing'],
        systemRole: 'Market prompt',
      },
      description: 'A market agent',
      identifier: 'mktobj1',
      related: [],
      tags: ['ai'],
      title: 'Object Model Agent',
    });

    const runtime = createRuntime();
    const result = await runtime.getAgentDetail({ agentId: 'mktobj1' });

    expect(result.success).toBe(true);
    expect(result.content).toContain('Model: openai/gpt-4o');
    expect(result.content).not.toContain('[object Object]');
    expect(result.state).toMatchObject({
      config: expect.objectContaining({ model: 'gpt-4o', provider: 'openai' }),
    });
  });

  it('still reports not found when the market fallback misses', async () => {
    mockGetAgentConfigById.mockResolvedValue(null);
    mockGetAssistantDetail.mockResolvedValue(undefined);

    const runtime = createRuntime();
    const result = await runtime.getAgentDetail({ agentId: 'ghost-id' });

    expect(result.success).toBe(false);
    expect(result.content).toBe('Agent "ghost-id" not found.');
  });

  it('treats a market lookup failure as best-effort and reports not found', async () => {
    mockGetAgentConfigById.mockResolvedValue(null);
    mockGetAssistantDetail.mockRejectedValue(new Error('network down'));

    const runtime = createRuntime();
    const result = await runtime.getAgentDetail({ agentId: 'offline-id' });

    expect(result.success).toBe(false);
    expect(result.content).toBe('Agent "offline-id" not found.');
  });

  it('does not hit the market for a local agent', async () => {
    mockGetAgentConfigById.mockResolvedValue({ id: 'agent-1', provider: 'lobehub' });

    const runtime = createRuntime();
    const result = await runtime.getAgentDetail({ agentId: 'agent-1' });

    expect(result.success).toBe(true);
    expect(mockGetAssistantDetail).not.toHaveBeenCalled();
  });
});

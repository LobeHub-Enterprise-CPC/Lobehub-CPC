// @vitest-environment node
import { runWithTenantScope, type TenantScope } from '@lobechat/database/tenant';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AssistantStore } from '@/server/modules/AssistantStore';
import { PluginStore } from '@/server/modules/PluginStore';
import { ModelSorts, PluginSorts, ProviderSorts } from '@/types/discover';

import { DiscoverService } from './index';

// Mock external dependencies
vi.mock('@/server/modules/AssistantStore');
vi.mock('@/server/modules/PluginStore');
vi.mock('@lobehub/market-sdk');
vi.mock('@/locales/resources', () => ({
  normalizeLocale: vi.fn(function (locale) {
    if (locale === 'en-US') return 'en';
    return locale || 'en';
  }),
}));

// Mock constants with inline data
vi.mock('model-bank', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as any),
    LOBE_DEFAULT_MODEL_LIST: [
      {
        id: 'gpt-4',
        displayName: 'GPT-4',
        description: 'OpenAI GPT-4 model',
        providerId: 'openai',
        contextWindowTokens: 8192,
        abilities: {
          vision: true,
          functionCall: true,
          files: true,
        },
        pricing: {
          input: 0.03,
          output: 0.06,
        },
        releasedAt: '2023-03-01T00:00:00Z',
      },
      {
        id: 'claude-3-opus',
        displayName: 'Claude 3 Opus',
        description: 'Anthropic Claude 3 Opus model',
        providerId: 'anthropic',
        contextWindowTokens: 200000,
        abilities: {
          vision: true,
          reasoning: true,
        },
        pricing: {
          input: 0.015,
          output: 0.075,
        },
        releasedAt: '2024-02-01T00:00:00Z',
      },
      {
        id: 'lobehub-onboarding-v1',
        displayName: 'LobeHub Onboarding',
        description: 'Runtime-only onboarding alias model',
        providerId: 'lobehub',
        contextWindowTokens: 1_000_000,
        abilities: {
          functionCall: true,
          reasoning: true,
        },
        releasedAt: '2026-04-24T00:00:00Z',
        visible: false,
      },
    ],
  };
});

vi.mock('@/business/client/model-bank/loadModels', async () => {
  const { LOBE_DEFAULT_MODEL_LIST } = await import('model-bank');
  return {
    loadModels: vi.fn().mockResolvedValue(LOBE_DEFAULT_MODEL_LIST),
  };
});

vi.mock('@/config/modelProviders', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as any),
    DEFAULT_MODEL_PROVIDER_LIST: [
      {
        id: 'openai',
        name: 'OpenAI',
        description: 'OpenAI provider',
      },
      {
        id: 'anthropic',
        name: 'Anthropic',
        description: 'Anthropic provider',
      },
    ],
  };
});

vi.mock('@/const/discover', () => ({
  DEFAULT_DISCOVER_ASSISTANT_ITEM: {},
  DEFAULT_DISCOVER_PLUGIN_ITEM: {},
  DEFAULT_DISCOVER_PROVIDER_ITEM: {},
}));

// Mock data - moved after mocks to avoid hoisting issues
const mockAssistantList = [
  {
    identifier: 'assistant-1',
    title: 'Test Assistant 1',
    description: 'A test assistant',
    author: 'Test Author',
    category: 'productivity',
    createdAt: '2024-01-01T00:00:00Z',
    knowledgeCount: 5,
    pluginCount: 2,
    tokenUsage: 1000,
    tags: ['test', 'assistant'],
  },
  {
    identifier: 'assistant-2',
    title: 'Test Assistant 2',
    description: 'Another test assistant',
    author: 'Test Author 2',
    category: 'productivity', // Changed to same category for related items test
    createdAt: '2024-01-02T00:00:00Z',
    knowledgeCount: 3,
    pluginCount: 1,
    tokenUsage: 500,
    tags: ['test', 'creative'],
  },
  {
    identifier: 'assistant-3',
    title: 'Test Assistant 3',
    description: 'A creative assistant',
    author: 'Test Author 3',
    category: 'creativity', // Keep this for category filtering tests
    createdAt: '2024-01-03T00:00:00Z',
    knowledgeCount: 2,
    pluginCount: 0,
    tokenUsage: 300,
    tags: ['test', 'creative'],
  },
];

const mockMarketAssistantList = [
  {
    identifier: 'market-assistant-1',
    name: 'Market Assistant 1',
    summary: 'First market assistant from new source',
    author: { name: 'Market Author 1', avatar: 'https://example.com/avatar1.png' },
    ownerId: 101,
    category: 'productivity',
    createdAt: '2024-02-01T00:00:00Z',
    updatedAt: '2024-02-02T00:00:00Z',
    avatar: 'https://example.com/avatar1.png',
    tags: ['market', 'assistant'],
    status: 'published',
    tokenUsage: 256,
    config: {
      systemRole: 'You are a productive assistant.',
      knowledgeBases: [{ id: 'kb-1' }],
      plugins: [{ id: 'plugin-1' }],
    },
  },
  {
    identifier: 'market-assistant-2',
    name: 'Market Assistant 2',
    summary: 'Second market assistant from new source',
    author: 'Market Author 2',
    ownerId: 202,
    category: 'creativity',
    createdAt: '2024-02-04T00:00:00Z',
    updatedAt: '2024-02-05T00:00:00Z',
    avatar: 'https://example.com/avatar2.png',
    tags: ['market', 'creative'],
    status: 'published',
    tokenUsage: 128,
    config: {
      systemRole: 'You are a creative assistant.',
      knowledgeBases: [],
      plugins: [],
    },
  },
];

const mockMarketAgentDetail = {
  ...mockMarketAssistantList[0],
  documentationUrl: 'https://example.com/docs',
  version: '1.0.0',
  versions: [
    {
      version: '1.0.0',
      status: 'published',
      isLatest: true,
      isValidated: true,
      createdAt: '2024-02-02T00:00:00Z',
    },
  ],
  examples: [
    {
      content: 'Example content',
      role: 'user',
    },
  ],
};

const mockPluginList = [
  {
    identifier: 'plugin-1',
    title: 'Test Plugin 1',
    description: 'A test plugin',
    author: 'Plugin Author',
    category: 'tools',
    createdAt: '2024-01-01T00:00:00Z',
    tags: ['test', 'plugin'],
    manifest: 'https://example.com/plugin1/manifest.json',
  },
  {
    identifier: 'plugin-2',
    title: 'Test Plugin 2',
    description: 'Another test plugin',
    author: 'Plugin Author 2',
    category: 'utilities',
    createdAt: '2024-01-02T00:00:00Z',
    tags: ['test', 'utility'],
    manifest: 'https://example.com/plugin2/manifest.json',
  },
];

describe('DiscoverService', () => {
  let service: DiscoverService;
  let mockAssistantStore: any;
  let mockPluginStore: any;
  let mockMarket: any;

  beforeEach(() => {
    vi.clearAllMocks();

    // Setup AssistantStore mock
    mockAssistantStore = {
      getAgentIndex: vi
        .fn()
        .mockResolvedValue(mockAssistantList.map((item) => ({ ...item, meta: {} }))),
      getAgent: vi.fn().mockImplementation(function (identifier) {
        const agent = mockAssistantList.find((a) => a.identifier === identifier);
        return Promise.resolve(agent ? { ...agent, meta: {} } : null);
      }),
    };

    // Setup PluginStore mock
    mockPluginStore = {
      getPluginList: vi
        .fn()
        .mockResolvedValue(mockPluginList.map((item) => ({ ...item, meta: {} }))),
    };

    // Setup MarketSDK mock
    mockMarket = {
      agents: {
        getAgentList: vi.fn().mockResolvedValue({
          categoryCounts: [
            { category: 'creativity', count: 1 },
            { category: 'productivity', count: 1 },
          ],
          items: mockMarketAssistantList,
          totalCount: mockMarketAssistantList.length,
          currentPage: 1,
          pageSize: 20,
          totalPages: 1,
        }),
        getAgentDetail: vi.fn().mockResolvedValue(mockMarketAgentDetail),
        getCategories: vi.fn().mockResolvedValue([
          { category: 'productivity', count: 10 },
          { category: 'creativity', count: 5 },
        ]),
        getPublishedIdentifiers: vi.fn().mockResolvedValue([
          { id: 'market-assistant-1', lastModified: '2024-02-02T00:00:00Z' },
          { id: 'market-assistant-2', lastModified: '2024-02-05T00:00:00Z' },
        ]),
      },
      plugins: {
        getCategories: vi.fn().mockResolvedValue([
          { category: 'tools', count: 5 },
          { category: 'utilities', count: 3 },
        ]),
        getPluginDetail: vi.fn().mockImplementation(function (params) {
          const plugin = mockPluginList.find((p) => p.identifier === params.identifier);
          return Promise.resolve(plugin || null);
        }),
        getPluginList: vi.fn().mockResolvedValue({
          items: mockPluginList,
          totalCount: mockPluginList.length,
          currentPage: 1,
          pageSize: 20,
          totalPages: 1,
        }),
        getPublishedIdentifiers: vi
          .fn()
          .mockResolvedValue(
            mockPluginList.map((p) => ({ identifier: p.identifier, lastModified: p.createdAt })),
          ),
        getPluginManifest: vi.fn().mockResolvedValue({}),
      },
    };

    (AssistantStore as any).mockImplementation(function () {
      return mockAssistantStore;
    });
    (PluginStore as any).mockImplementation(function () {
      return mockPluginStore;
    });

    service = new DiscoverService();
    service.market = mockMarket;
  });

  describe('Assistant Market (new source)', () => {
    it('getAssistantList should transform market SDK response', async () => {
      const result = await service.getAssistantList({ includeCategoryCounts: true });

      expect(mockMarket.agents.getAgentList).toHaveBeenCalledWith(
        expect.objectContaining({ includeCategoryCounts: true }),
      );
      expect(result.items[0]).toEqual(
        expect.objectContaining({
          identifier: 'market-assistant-1',
          title: 'Market Assistant 1',
          author: 'Market Author 1',
          knowledgeCount: 1,
          pluginCount: 1,
        }),
      );
      expect(result.categoryCounts).toEqual([
        { category: 'creativity', count: 1 },
        { category: 'productivity', count: 1 },
      ]);
    });

    describe('in a tenant', () => {
      const inTenant = <T>(fn: () => T) =>
        runWithTenantScope(
          { session: {}, slug: 'acme', tenantId: 'tenant-a' } as unknown as TenantScope,
          fn,
        );

      // Each tenant has its own schema, so "public" there is already visible to
      // that tenant only; Market's group list has no viewer filter, so the
      // parameter stays on in a tenant too.
      it('still narrows the catalogue to public content', async () => {
        await inTenant(() => service.getAssistantList({}));

        const [query] = mockMarket.agents.getAgentList.mock.calls[0];
        expect(query).toMatchObject({ status: 'published', visibility: 'public' });
      });

      it('narrows the group catalogue to public content as well', async () => {
        mockMarket.agentGroups = {
          ...mockMarket.agentGroups,
          getAgentGroupList: vi.fn().mockResolvedValue({ items: [], totalCount: 0 }),
        };

        await inTenant(() => service.getGroupAgentList({}));

        expect(mockMarket.agentGroups.getAgentGroupList).toHaveBeenCalledWith(
          expect.objectContaining({ status: 'published', visibility: 'public' }),
        );
      });

      it('keeps asking for public content outside a tenant', async () => {
        await service.getAssistantList({});

        expect(mockMarket.agents.getAgentList).toHaveBeenCalledWith(
          expect.objectContaining({ visibility: 'public' }),
        );
      });

      it('passes through what Market says the requester may do, and nothing it did not say', async () => {
        mockMarket.agents.getAgentList.mockResolvedValue({
          currentPage: 1,
          items: [
            { ...mockMarketAssistantList[0], canEdit: true, canUnpublish: false },
            { ...mockMarketAssistantList[1] },
          ],
          pageSize: 20,
          totalCount: 2,
          totalPages: 1,
        });

        const result = await inTenant(() => service.getAssistantList({}));

        expect(result.items[0]).toMatchObject({ canEdit: true, canUnpublish: false });
        expect(result.items[1]).not.toHaveProperty('canEdit');
        expect(result.items[1]).not.toHaveProperty('canUnpublish');
      });

      it('reads the rights off the detail response too', async () => {
        mockMarket.agents.getAgentDetail.mockResolvedValue({
          ...mockMarketAgentDetail,
          canEdit: true,
          canUnpublish: true,
        });

        const detail = await inTenant(() =>
          service.getAssistantDetail({ identifier: 'market-assistant-1' }),
        );

        expect(detail).toMatchObject({ canEdit: true, canUnpublish: true });
      });
    });

    // Market's `contentSync` (A2): null = no local sync binding, {detached:false}
    // = still following the platform, {detached:true} = cut loose. The three
    // states differ in what the UI says, so none may collapse into another, and
    // a response without the field says nothing at all.
    describe('contentSync', () => {
      const states = [
        ['no binding', null],
        ['still syncing', { detached: false }],
        ['detached', { detached: true }],
      ] as const;

      it.each(states)('keeps %s on agent list items', async (_name, contentSync) => {
        mockMarket.agents.getAgentList.mockResolvedValue({
          currentPage: 1,
          items: [{ ...mockMarketAssistantList[0], contentSync }],
          pageSize: 20,
          totalCount: 1,
          totalPages: 1,
        });

        const result = await service.getAssistantList({});

        expect(result.items[0].contentSync).toEqual(contentSync);
      });

      it.each(states)('keeps %s on the agent detail', async (_name, contentSync) => {
        mockMarket.agents.getAgentDetail.mockResolvedValue({
          ...mockMarketAgentDetail,
          contentSync,
        });

        const detail = await service.getAssistantDetail({ identifier: 'market-assistant-1' });

        expect(detail?.contentSync).toEqual(contentSync);
      });

      it('leaves the field out when Market did not report it', async () => {
        const detail = await service.getAssistantDetail({ identifier: 'market-assistant-1' });

        expect(detail).not.toHaveProperty('contentSync');
      });

      it('never forwards what else the sync binding knows (source, hash)', async () => {
        mockMarket.agents.getAgentDetail.mockResolvedValue({
          ...mockMarketAgentDetail,
          contentSync: { detached: true, hash: 'abc', sourceId: 7 },
        });

        const detail = await service.getAssistantDetail({ identifier: 'market-assistant-1' });

        expect(detail?.contentSync).toEqual({ detached: true });
      });

      it('ignores a value that is not one of the three states', async () => {
        mockMarket.agents.getAgentDetail.mockResolvedValue({
          ...mockMarketAgentDetail,
          contentSync: 'detached',
        });

        const detail = await service.getAssistantDetail({ identifier: 'market-assistant-1' });

        expect(detail).not.toHaveProperty('contentSync');
      });

      it('keeps it on every resource of a user profile', async () => {
        const sync = { detached: true };
        mockMarket.user = {
          getUserInfo: vi.fn().mockResolvedValue({
            agentGroups: [{ contentSync: sync, identifier: 'g1', name: 'G1' }],
            agents: [{ contentSync: sync, identifier: 'a1', name: 'A1' }],
            favoriteAgentGroups: [{ contentSync: sync, identifier: 'g3', name: 'G3' }],
            favoriteAgents: [{ contentSync: sync, identifier: 'a3', name: 'A3' }],
            forkedAgentGroups: [{ contentSync: sync, identifier: 'g2', name: 'G2' }],
            forkedAgents: [{ contentSync: sync, identifier: 'a2', name: 'A2' }],
            plugins: [{ contentSync: null, identifier: 'p1' }],
            skills: [{ contentSync: { detached: false }, identifier: 's1' }],
            user: { id: 1, userName: 'u' },
          }),
        };

        const profile = await service.getUserInfo({ username: 'u' });

        expect(profile?.agents[0].contentSync).toEqual(sync);
        expect(profile?.agentGroups[0].contentSync).toEqual(sync);
        expect(profile?.forkedAgents?.[0].contentSync).toEqual(sync);
        expect(profile?.forkedAgentGroups?.[0].contentSync).toEqual(sync);
        expect(profile?.favoriteAgents?.[0].contentSync).toEqual(sync);
        expect(profile?.favoriteAgentGroups?.[0].contentSync).toEqual(sync);
        expect(profile?.plugins?.[0].contentSync).toBeNull();
        expect(profile?.skills?.[0].contentSync).toEqual({ detached: false });
      });

      it('keeps it on MCP list and detail, and on the MCP behind a plugin detail', async () => {
        const mcp = { category: 'tools', contentSync: { detached: true }, identifier: 'mcp-x' };
        mockMarket.plugins.getPluginList.mockResolvedValue({ ...mockMarket.plugins, items: [mcp] });
        mockMarket.plugins.getPluginDetail.mockResolvedValue(mcp);

        const list = await service.getMcpList({});
        const detail = await service.getMcpDetail({ identifier: 'mcp-x' });
        const asPlugin = await service.getPluginDetail({ identifier: 'mcp-x' });

        expect((list.items[0] as any).contentSync).toEqual({ detached: true });
        expect((detail as any).contentSync).toEqual({ detached: true });
        expect((asPlugin as any)?.contentSync).toEqual({ detached: true });
      });

      it('reads a group detail from .group and passes it through', async () => {
        const response = {
          currentVersion: {},
          group: { contentSync: { detached: true }, identifier: 'g1' },
        };
        mockMarket.agentGroups = {
          getAgentGroupDetail: vi.fn().mockResolvedValue(response),
          getAgentGroupList: vi.fn().mockResolvedValue({
            items: [{ contentSync: { detached: false }, identifier: 'g1' }],
          }),
        };

        const detail = (await service.getGroupAgentDetail({ identifier: 'g1' })) as any;
        const list = (await service.getGroupAgentList()) as any;

        expect(detail.group.contentSync).toEqual({ detached: true });
        expect(detail).not.toHaveProperty('contentSync');
        expect(list.items[0].contentSync).toEqual({ detached: false });
      });
    });

    it('getAssistantList should preserve a successful empty response in strict mode', async () => {
      mockMarket.agents.getAgentList.mockResolvedValue({
        currentPage: 1,
        items: [],
        pageSize: 20,
        totalCount: 0,
        totalPages: 0,
      });

      const result = await service.getAssistantList({ q: 'missing' }, { throwOnError: true });

      expect(result).toEqual({
        currentPage: 1,
        items: [],
        pageSize: 20,
        totalCount: 0,
        totalPages: 0,
      });
    });

    it('getAssistantList should rethrow market errors in strict mode', async () => {
      const marketError = new Error('Market unavailable');
      mockMarket.agents.getAgentList.mockRejectedValue(marketError);

      await expect(
        service.getAssistantList({ q: 'assistant' }, { throwOnError: true }),
      ).rejects.toBe(marketError);
    });

    it('getAssistantList should retain the empty fallback by default', async () => {
      mockMarket.agents.getAgentList.mockRejectedValue(new Error('Market unavailable'));

      const result = await service.getAssistantList({ q: 'assistant' });

      expect(result).toEqual({
        currentPage: 1,
        items: [],
        pageSize: 20,
        totalCount: 0,
        totalPages: 0,
      });
    });

    it('getAssistantDetail should fetch from market SDK by default', async () => {
      const result = await service.getAssistantDetail({
        identifier: 'market-assistant-1',
      });

      expect(mockMarket.agents.getAgentDetail).toHaveBeenCalledWith('market-assistant-1', {
        locale: 'en',
        version: undefined,
      });
      expect(result).toEqual(
        expect.objectContaining({
          identifier: 'market-assistant-1',
          title: 'Market Assistant 1',
          related: expect.any(Array),
        }),
      );
    });

    it('getAssistantCategories should proxy to market SDK', async () => {
      const result = await service.getAssistantCategories({ locale: 'en-US', q: 'market' });

      expect(mockMarket.agents.getCategories).toHaveBeenCalledWith({
        locale: 'en',
        q: 'market',
      });
      expect(result).toEqual([
        { category: 'productivity', count: 10 },
        { category: 'creativity', count: 5 },
      ]);
    });

    it('getAssistantIdentifiers should read from market SDK', async () => {
      const result = await service.getAssistantIdentifiers();

      expect(mockMarket.agents.getPublishedIdentifiers).toHaveBeenCalled();
      expect(result).toEqual([
        { identifier: 'market-assistant-1', lastModified: '2024-02-02T00:00:00Z' },
        { identifier: 'market-assistant-2', lastModified: '2024-02-05T00:00:00Z' },
      ]);
    });
  });

  describe('Assistant Market (legacy source)', () => {
    describe('getAssistantList', () => {
      it('should return formatted assistant list with default parameters', async () => {
        const result = await service.getAssistantList({ source: 'legacy' });

        expect(result).toEqual({
          currentPage: 1,
          pageSize: 20,
          totalCount: 3,
          totalPages: 1,
          items: expect.arrayContaining([
            expect.objectContaining({
              identifier: 'assistant-1',
              title: 'Test Assistant 1',
            }),
            expect.objectContaining({
              identifier: 'assistant-2',
              title: 'Test Assistant 2',
            }),
            expect.objectContaining({
              identifier: 'assistant-3',
              title: 'Test Assistant 3',
            }),
          ]),
        });
      });

      it('should filter by category', async () => {
        const result = await service.getAssistantList({
          category: 'productivity',
          source: 'legacy',
        });

        expect(result.items).toHaveLength(2);
        expect(result.items.map((item) => item.identifier)).toContain('assistant-1');
        expect(result.items.map((item) => item.identifier)).toContain('assistant-2');
      });

      it('should filter by search query', async () => {
        const result = await service.getAssistantList({ q: 'creative', source: 'legacy' });

        expect(result.items).toHaveLength(2);
        expect(result.items.map((item) => item.identifier)).toContain('assistant-2');
        expect(result.items.map((item) => item.identifier)).toContain('assistant-3');
      });

      it('should paginate results', async () => {
        const result = await service.getAssistantList({ page: 1, pageSize: 1, source: 'legacy' });

        expect(result.items).toHaveLength(1);
        expect(result.currentPage).toBe(1);
        expect(result.pageSize).toBe(1);
        expect(result.totalPages).toBe(3);
      });
    });

    describe('getAssistantDetail', () => {
      it('should return assistant detail with related items', async () => {
        const result = await service.getAssistantDetail({
          identifier: 'assistant-1',
          source: 'legacy',
        });

        expect(result).toEqual(
          expect.objectContaining({
            identifier: 'assistant-1',
            title: 'Test Assistant 1',
            related: expect.any(Array),
          }),
        );
        expect(result?.related).toHaveLength(1);
        expect(result?.related[0].identifier).toBe('assistant-2');
      });

      it('should return undefined for non-existent assistant', async () => {
        mockAssistantStore.getAgent.mockResolvedValue(null);

        const result = await service.getAssistantDetail({
          identifier: 'non-existent',
          source: 'legacy',
        });

        expect(result).toBeUndefined();
      });
    });

    describe('getAssistantCategories', () => {
      it('should return category counts', async () => {
        const result = await service.getAssistantCategories({ source: 'legacy' });

        expect(result).toEqual([
          { category: 'productivity', count: 2 },
          { category: 'creativity', count: 1 },
        ]);
      });

      it('should filter categories by search query', async () => {
        const result = await service.getAssistantCategories({ q: 'creative', source: 'legacy' });

        expect(result).toEqual([
          {
            category: 'productivity',
            count: 1,
          },
          {
            category: 'creativity',
            count: 1,
          },
        ]);
      });
    });

    describe('getAssistantIdentifiers', () => {
      it('should return list of identifiers with lastModified dates', async () => {
        const result = await service.getAssistantIdentifiers({ source: 'legacy' });

        expect(result).toEqual([
          { identifier: 'assistant-1', lastModified: '2024-01-01T00:00:00Z' },
          { identifier: 'assistant-2', lastModified: '2024-01-02T00:00:00Z' },
          { identifier: 'assistant-3', lastModified: '2024-01-03T00:00:00Z' },
        ]);
      });
    });
  });

  describe('Plugin Market', () => {
    describe('getPluginList', () => {
      it('should return formatted plugin list with default parameters', async () => {
        const result = await service.getPluginList();

        expect(result).toEqual({
          currentPage: 1,
          pageSize: 20,
          totalCount: 2,
          totalPages: 1,
          items: expect.arrayContaining([
            expect.objectContaining({
              identifier: 'plugin-1',
              title: 'Test Plugin 1',
            }),
            expect.objectContaining({
              identifier: 'plugin-2',
              title: 'Test Plugin 2',
            }),
          ]),
        });
      });

      it('should filter by category', async () => {
        const result = await service.getPluginList({ category: 'tools' });

        expect(result.items).toHaveLength(1);
        expect(result.items[0].identifier).toBe('plugin-1');
      });

      it('should sort by identifier', async () => {
        const result = await service.getPluginList({
          sort: PluginSorts.Identifier,
          order: 'asc',
        });

        // Note: The service has reversed logic for identifier sorting
        expect(result.items[0].identifier).toBe('plugin-2');
        expect(result.items[1].identifier).toBe('plugin-1');
      });
    });

    describe('getPluginDetail', () => {
      it('should return plugin detail with related items', async () => {
        const result = await service.getPluginDetail({
          identifier: 'plugin-1',
        });

        expect(result).toEqual(
          expect.objectContaining({
            identifier: 'plugin-1',
            title: 'Test Plugin 1',
            related: expect.any(Array),
          }),
        );
      });

      it('should return undefined for non-existent plugin', async () => {
        const result = await service.getPluginDetail({
          identifier: 'non-existent',
        });

        expect(result).toBeUndefined();
      });
    });
  });

  describe('MCP Market', () => {
    describe('getMcpList', () => {
      it('should call market SDK with normalized locale', async () => {
        await service.getMcpList({ locale: 'en-US' });

        expect(mockMarket.plugins.getPluginList).toHaveBeenCalledWith(
          expect.objectContaining({
            locale: 'en',
          }),
          expect.any(Object),
        );
      });
    });

    // A tenant's catalogue includes its own content, so the data cache (keyed on
    // URL and headers, not on who asks) is not used for any MCP read in a tenant.
    describe('data cache', () => {
      beforeEach(() => {
        mockMarket.plugins.getPluginDetail.mockResolvedValue({
          category: 'tools',
          identifier: 'mcp-1',
        });
      });

      const inTenant = <T>(fn: () => T) =>
        runWithTenantScope(
          { session: {}, slug: 'acme', tenantId: 'tenant-a' } as unknown as TenantScope,
          fn,
        );

      it.each([
        ['getMcpList', () => service.getMcpList({ locale: 'en-US' }), 'getPluginList', 1],
        [
          'getMcpCategories',
          () => service.getMcpCategories({ locale: 'en-US' }),
          'getCategories',
          1,
        ],
        [
          'getMcpDetail',
          () => service.getMcpDetail({ identifier: 'mcp-1', locale: 'en-US' }),
          'getPluginDetail',
          1,
        ],
        [
          'getMcpManifest',
          () => service.getMcpManifest({ identifier: 'mcp-1', locale: 'en-US' }),
          'getPluginManifest',
          1,
        ],
      ] as const)(
        '%s skips the data cache in a tenant and keeps it outside one',
        async (_name, call, method, argIndex) => {
          await inTenant(call);
          expect((mockMarket.plugins as any)[method].mock.calls[0][argIndex]).toEqual({
            cache: 'no-store',
          });

          (mockMarket.plugins as any)[method].mockClear();
          await call();
          expect((mockMarket.plugins as any)[method].mock.calls[0][argIndex]).toEqual({
            next: expect.objectContaining({ revalidate: expect.any(Number) }),
          });
        },
      );
    });

    describe('getMcpDetail', () => {
      it('should return MCP detail with related items', async () => {
        const mockMcp = { identifier: 'mcp-1', category: 'tools' };
        mockMarket.plugins.getPluginDetail.mockResolvedValue(mockMcp);

        const result = await service.getMcpDetail({
          identifier: 'mcp-1',
        });

        expect(result).toEqual(
          expect.objectContaining({
            identifier: 'mcp-1',
            related: expect.any(Array),
          }),
        );
      });
    });
  });

  describe('Provider Market', () => {
    describe('getProviderList', () => {
      it('should return formatted provider list', async () => {
        const result = await service.getProviderList();

        expect(result.items).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              identifier: 'openai',
              name: 'OpenAI',
              modelCount: expect.any(Number),
            }),
            expect.objectContaining({
              identifier: 'anthropic',
              name: 'Anthropic',
              modelCount: expect.any(Number),
            }),
          ]),
        );
      });

      it('should filter by search query', async () => {
        const result = await service.getProviderList({ q: 'openai' });

        expect(result.items.length).toBeGreaterThan(0);
        expect(result.items).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              identifier: 'openai',
            }),
          ]),
        );
      });

      it('should sort by model count', async () => {
        const result = await service.getProviderList({
          sort: ProviderSorts.ModelCount,
          order: 'desc',
        });

        expect(result.items.length).toBeGreaterThan(0);
        for (let i = 1; i < result.items.length; i++) {
          expect(result.items[i - 1].modelCount).toBeGreaterThanOrEqual(result.items[i].modelCount);
        }
      });
    });

    describe('getProviderDetail', () => {
      it('should return provider detail', async () => {
        const result = await service.getProviderDetail({
          identifier: 'openai',
        });

        expect(result).toEqual(
          expect.objectContaining({
            identifier: 'openai',
            name: 'OpenAI',
            models: expect.any(Array),
            related: expect.any(Array),
          }),
        );
      });
    });
  });

  describe('Model Market', () => {
    describe('getModelList', () => {
      it('should return deduplicated model list', async () => {
        const result = await service.getModelList();

        expect(result.items).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              identifier: expect.any(String),
              displayName: expect.any(String),
              providers: expect.any(Array),
            }),
          ]),
        );
      });

      it('should filter by category', async () => {
        const result = await service.getModelList({ category: 'openai' });

        expect(result.items.length).toBeGreaterThan(0);
      });

      it('should sort by context window tokens', async () => {
        const result = await service.getModelList({
          sort: ModelSorts.ContextWindowTokens,
          order: 'desc',
        });

        expect(result.items).toHaveLength(2);
      });

      it('should filter by search query', async () => {
        const result = await service.getModelList({ q: 'gpt' });

        expect(result.items.length).toBeGreaterThan(0);
      });

      it('should filter hidden runtime-only models', async () => {
        const result = await service.getModelList({ q: 'onboarding' });

        expect(result.items).toEqual([]);
      });
    });

    describe('getModelDetail', () => {
      it('should return model detail with providers', async () => {
        const result = await service.getModelDetail({
          identifier: 'gpt-4',
        });

        expect(result).toEqual(
          expect.objectContaining({
            identifier: 'gpt-4',
            displayName: 'GPT-4',
            providers: expect.any(Array),
            related: expect.any(Array),
          }),
        );
      });

      it('should not expose hidden runtime-only model details', async () => {
        const result = await service.getModelDetail({
          identifier: 'lobehub-onboarding-v1',
        });

        expect(result).toBeUndefined();
      });
    });

    describe('getModelCategories', () => {
      it('should return model categories by provider', async () => {
        const result = await service.getModelCategories();

        expect(result).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              category: expect.any(String),
              count: expect.any(Number),
            }),
          ]),
        );
      });

      it('should not include categories that only have hidden models', async () => {
        const result = await service.getModelCategories();

        expect(result.some((item) => item.category === 'lobehub')).toBe(false);
      });
    });
  });

  describe('Helper Methods', () => {
    describe('calculateAbilitiesScore', () => {
      it('should calculate abilities score correctly', () => {
        const abilities = {
          vision: true,
          functionCall: true,
          files: false,
        };

        // Access private method for testing
        const score = (service as any).calculateAbilitiesScore(abilities);
        expect(score).toBe(2); // vision + functionCall
      });

      it('should return 0 for empty abilities', () => {
        const score = (service as any).calculateAbilitiesScore(null);
        expect(score).toBe(0);
      });
    });

    describe('selectModelWithBestAbilities', () => {
      it('should select model with best abilities', () => {
        const models = [
          {
            identifier: 'model-1',
            abilities: { vision: true },
            contextWindowTokens: 4000,
          },
          {
            identifier: 'model-1',
            abilities: { vision: true, functionCall: true },
            contextWindowTokens: 8000,
          },
        ];

        const result = (service as any).selectModelWithBestAbilities(models);

        expect(result.abilities).toEqual({ vision: true, functionCall: true });
        expect(result.contextWindowTokens).toBe(8000);
      });

      it('should return single model if only one provided', () => {
        const models = [{ identifier: 'model-1', abilities: {} }];

        const result = (service as any).selectModelWithBestAbilities(models);

        expect(result).toEqual(models[0]);
      });
    });
  });
});

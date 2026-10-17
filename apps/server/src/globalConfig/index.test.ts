import type * as BusinessConst from '@lobechat/business-const';
import type * as BusinessModelConfig from '@lobechat/business-model-bank/model-config';
import { type LobeDefaultAiModelListItem, ModelProvider } from 'model-bank';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadModels } from '@/business/client/model-bank/loadModels';
import type * as AppEnv from '@/envs/app';
import { getAppConfig } from '@/envs/app';

import { getServerAiProviderConfig, getServerDefaultAgentConfig } from './index';
import { parseAgentConfig } from './parseDefaultAgent';

vi.mock('@lobechat/business-const', async (importOriginal) => ({
  ...(await importOriginal<typeof BusinessConst>()),
  ENABLE_BUSINESS_FEATURES: true,
}));

vi.mock('@lobechat/business-model-bank/model-config', async (importOriginal) => ({
  ...(await importOriginal<typeof BusinessModelConfig>()),
  // Business builds gate server-default models per user; the catalog under test is open to all.
  isLobeHubModelAvailable: vi.fn().mockResolvedValue(true),
  loadModels: vi.fn(),
}));

vi.mock('@/envs/app', async (importOriginal) => ({
  ...(await importOriginal<typeof AppEnv>()),
  getAppConfig: vi.fn(),
}));

vi.mock('./parseDefaultAgent', () => ({
  parseAgentConfig: vi.fn(),
}));

describe('getServerAiProviderConfig', () => {
  const catalog: LobeDefaultAiModelListItem[] = [
    {
      enabled: true,
      id: 'claude-sonnet-4-6',
      maxOutput: 1024,
      providerId: 'anthropic',
      source: 'builtin',
      type: 'chat',
    },
    {
      enabled: true,
      id: 'claude-sonnet-4-6',
      maxOutput: 4096,
      providerId: 'lobehub',
      settings: { extendParams: ['enableAdaptiveThinking'] },
      source: 'builtin',
      type: 'chat',
    },
  ];

  beforeEach(() => {
    vi.stubEnv('LOBEHUB_MODEL_LIST', '');
    vi.mocked(loadModels).mockResolvedValue(catalog);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it('uses only the requested provider catalog and observes updates on the next read', async () => {
    expect(await getServerAiProviderConfig(ModelProvider.LobeHub)).toEqual({
      enabled: true,
      enabledModels: undefined,
      serverModelLists: [catalog[1]],
    });

    vi.mocked(loadModels).mockResolvedValue([catalog[0]]);
    expect((await getServerAiProviderConfig(ModelProvider.LobeHub)).serverModelLists).toEqual([]);
    expect((await getServerAiProviderConfig(ModelProvider.Anthropic)).enabled).toBe(false);
  });

  it('applies model-list overrides using the same provider metadata and preserves an empty list', async () => {
    vi.stubEnv('LOBEHUB_MODEL_LIST', '-all,+claude-sonnet-4-6=Relay Claude');
    expect((await getServerAiProviderConfig(ModelProvider.LobeHub)).serverModelLists).toEqual([
      { ...catalog[1], abilities: {}, displayName: 'Relay Claude' },
    ]);

    vi.stubEnv('LOBEHUB_MODEL_LIST', '-all');
    expect((await getServerAiProviderConfig(ModelProvider.LobeHub)).serverModelLists).toEqual([]);
  });

  it('loads one catalog snapshot for all model-list type and metadata lookups', async () => {
    vi.stubEnv('LOBEHUB_MODEL_LIST', '-all,+claude-sonnet-4-6,+bge-custom');
    vi.mocked(loadModels).mockResolvedValue([{ ...catalog[0], type: 'image' }, catalog[1]]);

    const result = await getServerAiProviderConfig(ModelProvider.LobeHub);

    expect(result.enabledModels).toEqual(['claude-sonnet-4-6', 'bge-custom']);
    expect(result.serverModelLists).toMatchObject([
      { id: 'claude-sonnet-4-6', maxOutput: 4096, type: 'chat' },
      { id: 'bge-custom', type: 'embedding' },
    ]);
    expect(loadModels).toHaveBeenCalledTimes(1);
  });

  it('preserves adaptive thinking when resolving a model from the default catalog', async () => {
    const { resolveServerDefaultHeterogeneousModel } = await import('../modules/ModelRuntime');

    await expect(
      resolveServerDefaultHeterogeneousModel('claude-code', 'claude-sonnet-4-6'),
    ).resolves.toEqual({
      maxOutput: 4096,
      model: 'claude-sonnet-4-6',
      provider: 'lobehub',
      supportsAdaptiveThinking: true,
    });
  });
});

describe('getServerDefaultAgentConfig', () => {
  it('should return parsed agent config', () => {
    const mockConfig = { key: 'value' };
    vi.mocked(getAppConfig).mockReturnValue({
      DEFAULT_AGENT_CONFIG: 'test_agent_config',
    } as any);
    vi.mocked(parseAgentConfig).mockReturnValue(mockConfig);

    const result = getServerDefaultAgentConfig();

    expect(parseAgentConfig).toHaveBeenCalledWith('test_agent_config');
    expect(result).toEqual(mockConfig);
  });

  it('should return empty object if parseAgentConfig returns undefined', () => {
    vi.mocked(getAppConfig).mockReturnValue({
      DEFAULT_AGENT_CONFIG: 'test_agent_config',
    } as any);
    vi.mocked(parseAgentConfig).mockReturnValue(undefined);

    const result = getServerDefaultAgentConfig();

    expect(result).toEqual({});
  });
});

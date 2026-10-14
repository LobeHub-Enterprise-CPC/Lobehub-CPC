import type { TenantSettings, TenantSystemModels } from '@lobechat/business-config/tenant-settings';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_FILES_CONFIG } from '@/const/settings/knowledge';

import { parseSystemAgent } from './parseSystemAgent';
import { getServerSystemModels } from './systemModels';

const mocks = vi.hoisted(() => ({
  appEnv: {} as Record<string, string | undefined>,
  knowledgeEnv: {} as Record<string, string | undefined>,
  tenantSettings: undefined as TenantSettings | undefined,
  toolsEnv: {} as Record<string, unknown>,
}));

vi.mock('@lobechat/business-config/tenant-settings', () => ({
  loadTenantSettings: vi.fn(async () => mocks.tenantSettings),
}));
vi.mock('@/envs/app', () => ({ appEnv: mocks.appEnv }));
vi.mock('@/envs/knowledge', () => ({ knowledgeEnv: mocks.knowledgeEnv }));
vi.mock('@/envs/tools', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  toolsEnv: mocks.toolsEnv,
}));

const asTenant = (systemModels: TenantSystemModels) => {
  mocks.tenantSettings = {
    featureFlags: {},
    loginMethods: { emailPassword: true, magicLink: false, requireEmailVerification: false },
    systemModels,
  };
};

const setDeploymentEnv = () => {
  mocks.appEnv.SYSTEM_AGENT = 'default=openai/env-chat,topic=openai/env-topic';
  mocks.knowledgeEnv.DEFAULT_FILES_CONFIG = 'embedding_model=openai/env-embedding';
  mocks.toolsEnv.MULTIMODAL_UNDERSTANDING_IMAGE_FORMATS = ['image/webp'];
  mocks.toolsEnv.MULTIMODAL_UNDERSTANDING_MODEL = 'env-vision';
  mocks.toolsEnv.MULTIMODAL_UNDERSTANDING_PROVIDER = 'google';
};

beforeEach(() => {
  mocks.tenantSettings = undefined;
  for (const env of [mocks.appEnv, mocks.knowledgeEnv, mocks.toolsEnv]) {
    for (const key of Object.keys(env)) delete env[key];
  }
});

describe('getServerSystemModels in business builds', () => {
  it("resolves each tenant's own models and ignores the deployment env", async () => {
    setDeploymentEnv();

    asTenant({
      fileEmbedding: 'acme-embedding',
      multimodalUnderstanding: 'acme-vision',
      systemAgent: { topic: 'acme-topic' },
    });
    const acme = await getServerSystemModels();

    asTenant({ systemAgent: { default: 'globex-chat' } });
    const globex = await getServerSystemModels();

    expect(acme.systemAgent).toEqual({ topic: { model: 'acme-topic', provider: 'lobehub' } });
    expect(acme.filesConfig).toEqual({
      ...DEFAULT_FILES_CONFIG,
      embeddingModel: { model: 'acme-embedding', provider: 'lobehub' },
    });
    expect(acme.multimodalUnderstanding).toEqual({
      imageFormats: ['image/jpeg', 'image/png'],
      model: 'acme-vision',
      provider: 'lobehub',
    });

    expect(globex.systemAgent.topic).toEqual({ model: 'globex-chat', provider: 'lobehub' });
    expect(globex.systemAgent.translation).toEqual({ model: 'globex-chat', provider: 'lobehub' });
    expect(globex.filesConfig).toEqual(DEFAULT_FILES_CONFIG);
    expect(globex.multimodalUnderstanding).toBeUndefined();
  });

  it('falls back to code defaults for a tenant without system models', async () => {
    setDeploymentEnv();
    asTenant({});

    await expect(getServerSystemModels()).resolves.toEqual({
      filesConfig: DEFAULT_FILES_CONFIG,
      multimodalUnderstanding: undefined,
      systemAgent: {},
    });
  });

  // The tenant `systemAgent` row and the `SYSTEM_AGENT` variable share one
  // meaning of `default` (spec FR-TS-03); drive both entries with the same cases.
  it.each<[string, Record<string, string>]>([
    ['default only', { default: 'chat' }],
    ['default with an explicit slot', { default: 'chat', topic: 'topic-model' }],
    ['memory slots stay explicit', { default: 'chat', userMemoryEmbedding: 'embedding' }],
    ['speech-to-text stays explicit', { asr: 'transcribe', default: 'chat' }],
    ['enabled flags of prompt rewrite', { promptRewrite: 'rewrite' }],
    ['unknown slots are ignored', { default: 'chat', unknown: 'model' }],
  ])('builds the same config as SYSTEM_AGENT: %s', async (_, slots) => {
    asTenant({ systemAgent: slots });
    const envString = Object.entries(slots)
      .map(([slot, model]) => `${slot}=lobehub/${model}`)
      .join(',');

    const { systemAgent } = await getServerSystemModels();

    expect(systemAgent).toStrictEqual(parseSystemAgent(envString));
  });
});

describe('getServerSystemModels in other builds', () => {
  it('parses the deployment env', async () => {
    setDeploymentEnv();

    const result = await getServerSystemModels();

    expect(result.systemAgent).toStrictEqual(parseSystemAgent(mocks.appEnv.SYSTEM_AGENT));
    expect(result.filesConfig.embeddingModel).toEqual({
      model: 'env-embedding',
      provider: 'openai',
    });
    expect(result.multimodalUnderstanding).toEqual({
      imageFormats: ['image/webp'],
      model: 'env-vision',
      provider: 'google',
    });
  });

  it('keeps multimodal understanding off unless both provider and model are set', async () => {
    mocks.toolsEnv.MULTIMODAL_UNDERSTANDING_MODEL = 'env-vision';

    const result = await getServerSystemModels();

    expect(result.multimodalUnderstanding).toBeUndefined();
    expect(result.filesConfig).toEqual(DEFAULT_FILES_CONFIG);
  });
});

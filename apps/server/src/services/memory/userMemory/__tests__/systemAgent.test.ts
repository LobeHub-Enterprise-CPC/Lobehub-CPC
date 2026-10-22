import type { TenantSettings } from '@lobechat/business-config/tenant-settings';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveMemoryServiceModelConfig } from '../systemAgent';

const mocks = vi.hoisted(() => ({
  appEnv: {} as Record<string, string | undefined>,
  tenantSettings: undefined as TenantSettings | undefined,
}));

vi.mock('@lobechat/business-config/tenant-settings', () => ({
  loadTenantSettings: vi.fn(async () => mocks.tenantSettings),
}));
vi.mock('@/envs/app', () => ({ appEnv: mocks.appEnv }));

const tenantSystemAgent = (systemAgent: Record<string, string>) => {
  mocks.tenantSettings = { featureFlags: {}, systemModels: { systemAgent } };
};

describe('resolveMemoryServiceModelConfig', () => {
  beforeEach(() => {
    mocks.tenantSettings = undefined;
    delete mocks.appEnv.SYSTEM_AGENT;
  });

  it("uses the tenant's memory models for slots the user left unset", async () => {
    tenantSystemAgent({
      memoryAnalysisAgentConfig: 'tenant-analysis',
      userMemoryEmbedding: 'tenant-embedding',
      userMemoryPersonaWriter: 'tenant-persona',
    });

    const result = await resolveMemoryServiceModelConfig({
      userMemoryEmbedding: { contextLimit: 2000 } as any,
    });

    expect(result?.memoryAnalysisAgentConfig).toMatchObject({
      model: 'tenant-analysis',
      provider: 'lobehub',
    });
    expect(result?.userMemoryPersonaWriter).toMatchObject({
      model: 'tenant-persona',
      provider: 'lobehub',
    });
    // A user tuning only the context limit keeps the tenant's model.
    expect(result?.userMemoryEmbedding).toMatchObject({
      contextLimit: 2000,
      model: 'tenant-embedding',
      provider: 'lobehub',
    });
  });

  it("keeps the user's own model choice over the tenant's", async () => {
    tenantSystemAgent({ memoryAnalysisAgentConfig: 'tenant-analysis' });

    const result = await resolveMemoryServiceModelConfig({
      memoryAnalysisAgentConfig: { model: 'user-analysis', provider: 'openai' },
    });

    expect(result?.memoryAnalysisAgentConfig).toMatchObject({
      model: 'user-analysis',
      provider: 'openai',
    });
  });

  it('does not fill memory slots from the tenant default model', async () => {
    tenantSystemAgent({ default: 'tenant-chat' });

    const result = await resolveMemoryServiceModelConfig(undefined);

    expect(result?.memoryAnalysisAgentConfig).toBeUndefined();
    expect(result?.userMemoryEmbedding).toBeUndefined();
    expect(result?.userMemoryPersonaWriter).toBeUndefined();
  });

  it('applies only the user settings outside business builds', async () => {
    mocks.appEnv.SYSTEM_AGENT = 'userMemoryEmbedding=openai/env-embedding';
    const userSystemAgent = { topic: { model: 'user-topic', provider: 'openai' } } as any;

    await expect(resolveMemoryServiceModelConfig(userSystemAgent)).resolves.toBe(userSystemAgent);
  });
});

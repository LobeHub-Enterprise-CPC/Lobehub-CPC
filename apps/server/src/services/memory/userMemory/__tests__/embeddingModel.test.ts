import type { TenantSettings } from '@lobechat/business-config/tenant-settings';
import type { LobeChatDatabase } from '@lobechat/database';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveUserMemoryEmbeddingModel } from '../embeddingModel';

const mocks = vi.hoisted(() => ({
  appEnv: {} as Record<string, string | undefined>,
  extractionEmbedding: { model: 'env-embedding', provider: 'env-provider' } as {
    model: string;
    provider: string;
  },
  tenantSettings: undefined as TenantSettings | undefined,
}));

vi.mock('@lobechat/business-config/tenant-settings', () => ({
  loadTenantSettings: vi.fn(async () => mocks.tenantSettings),
}));
vi.mock('@/envs/app', () => ({ appEnv: mocks.appEnv }));
vi.mock('@/server/globalConfig/parseMemoryExtractionConfig', () => ({
  parseMemoryExtractionConfig: () => ({ embedding: mocks.extractionEmbedding }),
}));
vi.mock('@/database/schemas', () => ({ userSettings: { id: 'id' } }));

const createDb = (systemAgent?: Record<string, unknown>) =>
  ({
    query: {
      userSettings: {
        findFirst: vi.fn(async () => (systemAgent ? { systemAgent } : undefined)),
      },
    },
  }) as unknown as LobeChatDatabase;

describe('resolveUserMemoryEmbeddingModel', () => {
  beforeEach(() => {
    mocks.tenantSettings = undefined;
    mocks.extractionEmbedding = { model: 'env-embedding', provider: 'env-provider' };
    delete mocks.appEnv.SYSTEM_AGENT;
  });

  it('falls back to the extraction config embedding model when nothing is configured', async () => {
    await expect(resolveUserMemoryEmbeddingModel(createDb(), 'user-1')).resolves.toEqual({
      model: 'env-embedding',
      provider: 'env-provider',
    });
  });

  it("uses the user's own userMemoryEmbedding choice over the extraction config", async () => {
    const db = createDb({ userMemoryEmbedding: { model: 'user-embedding', provider: 'openai' } });

    await expect(resolveUserMemoryEmbeddingModel(db, 'user-1')).resolves.toEqual({
      model: 'user-embedding',
      provider: 'openai',
    });
  });

  it("uses the tenant's userMemoryEmbedding, not the file embedding model, in business builds", async () => {
    mocks.tenantSettings = {
      featureFlags: {},
      systemModels: {
        fileEmbedding: 'tenant-file-embedding',
        systemAgent: { userMemoryEmbedding: 'doubao-embedding-vision' },
      },
    } as TenantSettings;

    const result = await resolveUserMemoryEmbeddingModel(createDb(), 'user-1');

    expect(result.model).toBe('doubao-embedding-vision');
  });

  it("lets the user's choice win over the tenant's", async () => {
    mocks.tenantSettings = {
      featureFlags: {},
      systemModels: { systemAgent: { userMemoryEmbedding: 'tenant-embedding' } },
    } as TenantSettings;
    const db = createDb({ userMemoryEmbedding: { model: 'user-embedding', provider: 'openai' } });

    await expect(resolveUserMemoryEmbeddingModel(db, 'user-1')).resolves.toEqual({
      model: 'user-embedding',
      provider: 'openai',
    });
  });
});

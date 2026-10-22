import { beforeEach, describe, expect, it, vi } from 'vitest';

import { userMemoriesRouter } from '../userMemories';

const mocks = vi.hoisted(() => ({
  embedUserMemoryTexts: vi.fn(),
  initModelRuntimeFromDB: vi.fn(),
  resolveUserMemoryEmbeddingModel: vi.fn(),
  searchMemory: vi.fn(),
}));

vi.mock('@/database/models/userMemory', () => {
  const Model = vi.fn(function () {
    return { searchMemory: mocks.searchMemory };
  });

  return {
    normalizeUserMemorySearchQueries: (queries?: string[]) => queries ?? [],
    shouldRunUserMemoryLexicalSearch: () => false,
    UserMemoryActivityModel: Model,
    UserMemoryExperienceModel: Model,
    UserMemoryIdentityModel: Model,
    UserMemoryModel: Model,
  };
});
vi.mock('@/database/repositories/userMemory', () => ({ UserMemoryTopicRepository: vi.fn() }));
vi.mock('@/business/server/trpc-middlewares/rbacPermission', () => ({
  withScopedPermission: () => async (opts: any) => opts.next(),
}));
vi.mock('@/libs/trpc/lambda/middleware', async () => {
  const { experimental_standaloneMiddleware } = await import('@trpc/server');
  return {
    serverDatabase: experimental_standaloneMiddleware().create(async (opts) => opts.next()),
  };
});
vi.mock('@/server/modules/ModelRuntime', () => ({
  initModelRuntimeFromDB: mocks.initModelRuntimeFromDB,
}));
vi.mock('@/server/services/ftsSearch', () => ({
  createFtsSearchRepo: vi.fn(async () => ({ ftsSearchCandidateEnabled: false })),
}));
vi.mock('@/server/services/ftsSearch/observability', () => ({
  recordUserMemoryLexicalSearchDecision: vi.fn(),
}));
vi.mock('@/server/services/memory/userMemory/embedding', () => ({
  embedUserMemoryTexts: mocks.embedUserMemoryTexts,
}));
vi.mock('@/server/services/memory/userMemory/embeddingModel', () => ({
  resolveUserMemoryEmbeddingModel: mocks.resolveUserMemoryEmbeddingModel,
}));

const createCaller = () =>
  userMemoriesRouter.createCaller({
    serverDB: { query: { userSettings: { findFirst: vi.fn(async () => undefined) } } },
    userId: 'user-1',
  } as any);

describe('userMemoriesRouter embedding model', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveUserMemoryEmbeddingModel.mockResolvedValue({
      model: 'memory-embedding-model',
      provider: 'memory-provider',
    });
    mocks.initModelRuntimeFromDB.mockResolvedValue({ embeddings: vi.fn() });
    mocks.embedUserMemoryTexts.mockResolvedValue([[0.1, 0.2]]);
    mocks.searchMemory.mockResolvedValue({ activities: [] });
  });

  // Vectors are written with the memory embedding model; querying with the file
  // embedding model finds nothing, so search must use the same one.
  it('embeds search queries with the resolved memory embedding model', async () => {
    await createCaller().searchMemory({ queries: ['renewal timeline'] } as any);

    expect(mocks.resolveUserMemoryEmbeddingModel).toHaveBeenCalledWith(expect.anything(), 'user-1');
    expect(mocks.embedUserMemoryTexts).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'memory-embedding-model' }),
    );
  });
});

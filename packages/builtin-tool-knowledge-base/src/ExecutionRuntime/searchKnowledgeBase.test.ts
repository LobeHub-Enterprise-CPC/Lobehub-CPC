import { describe, expect, it, vi } from 'vitest';

import { KnowledgeBaseExecutionRuntime } from './index';

const emptySearch = { chunks: [], documents: [], fileResults: [] };

const createRuntime = (searchResult: Record<string, unknown> = emptySearch) => {
  const ragService = {
    getFileContents: vi.fn(),
    semanticSearchForChat: vi.fn(async () => searchResult as any),
  };
  return { ragService, runtime: new KnowledgeBaseExecutionRuntime(ragService) };
};

describe('KnowledgeBaseExecutionRuntime.searchKnowledgeBase', () => {
  it.each([
    ['all attached libraries revoked', ['revoked-a', 'revoked-b'], 2],
    ['enterprise libraries skipped for a share visitor', ['enterprise-a'], 1],
  ] as const)(
    'retains skipped-library counts with no searched scope: %s',
    async (_case, ids, count) => {
      const { runtime } = createRuntime({
        ...emptySearch,
        searchedKnowledgeBaseIds: [],
        skippedKnowledgeBaseCount: count,
      });

      const result = await runtime.searchKnowledgeBase(
        { query: 'quarterly revenue forecast' },
        { knowledgeBaseIds: [...ids] },
      );

      expect(result.success).toBe(true);
      expect(result.state).toMatchObject({
        chunks: [],
        documents: [],
        fileResults: [],
        scope: 'none',
        skippedKnowledgeBaseCount: count,
        totalResults: 0,
      });
      expect(result.content).toContain('No enabled knowledge base');
    },
  );

  it('tells the model no knowledge base is attached when the service searched an empty scope', async () => {
    const { runtime } = createRuntime({ ...emptySearch, searchedKnowledgeBaseIds: [] });

    const result = await runtime.searchKnowledgeBase({ query: 'quarterly revenue forecast' });

    expect(result.success).toBe(true);
    expect(result.content).toContain('No enabled knowledge base is in this agent');
    expect(result.content).toContain('readKnowledge');
    expect(result.content).not.toContain('No relevant files found');
    // The card and chip read this to say "no library attached" instead of "No results".
    expect(result.state).toMatchObject({ scope: 'none', totalResults: 0 });
  });

  it('skips the search entirely when the caller passes an empty knowledge base scope', async () => {
    const { ragService, runtime } = createRuntime();

    const result = await runtime.searchKnowledgeBase(
      { query: 'quarterly revenue forecast' },
      { knowledgeBaseIds: [] },
    );

    expect(ragService.semanticSearchForChat).not.toHaveBeenCalled();
    expect(result.content).toContain('No enabled knowledge base is in this agent');
    expect(result.state).toMatchObject({ scope: 'none' });
  });

  it('keeps the "no relevant files" message when an attached knowledge base has no match', async () => {
    const { runtime } = createRuntime({ ...emptySearch, searchedKnowledgeBaseIds: ['kb_sales'] });

    const result = await runtime.searchKnowledgeBase(
      { query: 'quarterly revenue forecast' },
      { knowledgeBaseIds: ['kb_sales'] },
    );

    expect(result.content).toContain('No relevant files found');
    expect(result.content).not.toContain('No enabled knowledge base');
    expect(result.state).not.toHaveProperty('scope');
  });
});

import { describe, expect, it, vi } from 'vitest';

import { enterpriseKnowledgeService } from './enterpriseKnowledge';

const { resolveLevel } = vi.hoisted(() => ({ resolveLevel: vi.fn() }));
vi.mock('@/libs/trpc/client', () => ({
  lambdaClient: { enterpriseKnowledge: { resolveLevel: { query: resolveLevel } } },
}));

describe('enterprise bulk and move node checks', () => {
  it('requires edit on every source and the destination, even if the library permits editing', async () => {
    resolveLevel.mockImplementation(async ({ nodeId }) => ({
      level: nodeId === 'destination' ? 'path' : 'edit',
    }));
    expect(
      await enterpriseKnowledgeService.canEditNodes('library', ['source', 'destination']),
    ).toBe(false);
    resolveLevel.mockImplementation(async ({ nodeId }) => ({
      level: nodeId === 'source' ? 'view' : 'edit',
    }));
    expect(
      await enterpriseKnowledgeService.canEditNodes('library', ['source', 'destination']),
    ).toBe(false);
    resolveLevel.mockImplementation(async ({ nodeId }) => ({
      level: nodeId === 'source' ? 'owner' : 'edit',
    }));
    expect(
      await enterpriseKnowledgeService.canEditNodes('library', ['source', 'destination', null]),
    ).toBe(true);
  });

  it('does not permit a mutation when a level lookup fails', async () => {
    resolveLevel.mockRejectedValueOnce({ data: { code: 'NOT_FOUND' } });
    await expect(
      enterpriseKnowledgeService.canEditNodes('library', ['revoked']),
    ).rejects.toMatchObject({ data: { code: 'NOT_FOUND' } });
  });
});

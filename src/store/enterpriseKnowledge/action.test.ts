/** @vitest-environment happy-dom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cacheScope } from '@/libs/replica';
import { enterpriseKnowledgeService } from '@/services/enterpriseKnowledge';

import { enterpriseKnowledgeActions } from './action';
import { initialState, useEnterpriseKnowledgeStore } from './store';

vi.mock('@/business/client/hooks/useActiveWorkspaceId', () => ({
  getActiveWorkspaceId: () => null,
}));
vi.mock('@/services/enterpriseKnowledge', () => ({
  enterpriseKnowledgeService: { getAccess: vi.fn(), updateAccess: vi.fn() },
}));
vi.mock('@/store/library', () => ({
  useKnowledgeBaseStore: { getState: () => ({ refreshKnowledgeBaseList: vi.fn() }) },
}));

describe('enterprise access optimistic version conflict', () => {
  beforeEach(() => {
    vi.spyOn(cacheScope, 'get').mockReturnValue('test-enterprise-access:personal');
    vi.spyOn(cacheScope, 'canPersist').mockReturnValue(false);
    useEnterpriseKnowledgeStore.setState(initialState);
  });
  afterEach(() => {
    enterpriseKnowledgeActions.reset();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('rejects the stale edit, refreshes the latest roster and never retries a replacement', async () => {
    const latest = {
      grants: [
        {
          accessLevel: 'edit' as const,
          deleted: false,
          memberCount: 3,
          name: 'Engineering',
          principalId: 'dept-1',
          principalType: 'department' as const,
        },
      ],
      version: 4,
    };
    const conflict = { data: { code: 'CONFLICT' } };
    vi.mocked(enterpriseKnowledgeService.updateAccess).mockRejectedValue(conflict);
    vi.mocked(enterpriseKnowledgeService.getAccess).mockResolvedValue(latest);

    await expect(enterpriseKnowledgeActions.updateAccess('kb-1', 2, [])).rejects.toBe(conflict);

    expect(useEnterpriseKnowledgeStore.getState().accessMap['kb-1']).toEqual(latest);
    expect(enterpriseKnowledgeService.updateAccess).toHaveBeenCalledTimes(1);
  });
});

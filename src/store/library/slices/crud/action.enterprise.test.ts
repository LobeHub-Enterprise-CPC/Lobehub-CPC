/** @vitest-environment happy-dom */
import { randomUUID } from 'node:crypto';

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { createElement } from 'react';
import { SWRConfig } from 'swr';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cacheScope } from '@/libs/replica';
import { knowledgeBaseService } from '@/services/knowledgeBase';
import type { KnowledgeBaseItem } from '@/types/knowledgeBase';

import { useKnowledgeBaseStore } from '../../store';
import { initialKnowledgeBaseState } from './initialState';
import { knowledgeBaseItemResource, knowledgeBaseListResource } from './projection';
import { knowledgeBaseSelectors } from './selectors';

vi.mock('@/business/client/hooks/useActiveWorkspaceId', () => ({
  getActiveWorkspaceId: () => null,
  useActiveWorkspaceId: () => null,
}));
vi.mock('@/services/knowledgeBase', () => ({
  knowledgeBaseService: { getKnowledgeBaseById: vi.fn(), getKnowledgeBaseList: vi.fn() },
}));
const wrapper = ({ children }: PropsWithChildren) =>
  createElement(SWRConfig, { value: { provider: () => new Map(), dedupingInterval: 0 } }, children);
const library = (level: 'view' | 'edit' | 'owner'): KnowledgeBaseItem => ({
  avatar: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
  enterprise: { accessLevel: level, ownerName: 'Owner' },
  id: 'kb-enterprise',
  isPublic: false,
  name: 'Enterprise',
  settings: {},
  type: null,
});

describe('live enterprise library permissions', () => {
  let scope = '';
  beforeEach(() => {
    scope = `kb-enterprise-${randomUUID()}:personal`;
    vi.spyOn(cacheScope, 'get').mockImplementation(() => scope);
    vi.spyOn(cacheScope, 'use').mockImplementation(() => scope);
    vi.spyOn(cacheScope, 'canPersist').mockReturnValue(true);
    useKnowledgeBaseStore.setState(initialKnowledgeBaseState);
  });
  afterEach(async () => {
    cleanup();
    await Promise.all(
      ['all', 'public', 'private'].map((key) =>
        knowledgeBaseListResource.storage!.remove({ queryKey: key, scope }),
      ),
    );
    await knowledgeBaseItemResource.storage!.remove({ queryKey: 'kb-enterprise', scope });
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });
  it('a list revalidation downgrades every loaded surface, including a sidebar without a detail fetch', async () => {
    act(() =>
      useKnowledgeBaseStore.setState({ knowledgeBaseListMap: { public: [library('owner')] } }),
    );
    vi.mocked(knowledgeBaseService.getKnowledgeBaseList).mockResolvedValue([
      library('view'),
    ] as never);
    renderHook(() => useKnowledgeBaseStore.getState().useFetchKnowledgeBaseList(), { wrapper });
    await waitFor(() =>
      expect(
        useKnowledgeBaseStore.getState().knowledgeBaseListMap.all?.[0]?.enterprise?.accessLevel,
      ).toBe('view'),
    );
    expect(
      knowledgeBaseSelectors.getLoadedKnowledgeBaseById('kb-enterprise')(
        useKnowledgeBaseStore.getState(),
      )?.enterprise?.accessLevel,
    ).toBe('view');
  });
  it('a confirmed NOT_FOUND clears old detail and list copies so writes cannot survive revocation', async () => {
    act(() =>
      useKnowledgeBaseStore.setState({
        knowledgeBaseListMap: { all: [library('edit')] },
        knowledgeBaseDetailMap: { 'kb-enterprise': library('edit') },
      }),
    );
    vi.mocked(knowledgeBaseService.getKnowledgeBaseById).mockRejectedValue({
      data: { code: 'NOT_FOUND' },
    });
    renderHook(() => useKnowledgeBaseStore.getState().useFetchKnowledgeBaseItem('kb-enterprise'), {
      wrapper,
    });
    await waitFor(() =>
      expect(
        knowledgeBaseSelectors.sessionAccess(
          scope,
          'kb-enterprise',
        )(useKnowledgeBaseStore.getState()),
      ).toBe('denied'),
    );
    expect(
      knowledgeBaseSelectors.getLoadedKnowledgeBaseById('kb-enterprise')(
        useKnowledgeBaseStore.getState(),
      ),
    ).toBeUndefined();
  });
});

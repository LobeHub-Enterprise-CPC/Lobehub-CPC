import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { createElement, type PropsWithChildren } from 'react';
import { SWRConfig } from 'swr';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cacheScope } from '@/libs/replica';
import {
  enterpriseKnowledgeActions,
  useEnterpriseKnowledgeStore,
} from '@/store/enterpriseKnowledge';

import { useDocumentLibraryPermission } from './useDocumentLibraryPermission';

const fixtures = vi.hoisted(() => ({
  resolveLevel: vi.fn(),
  documents: { 'document-1': { document: { knowledgeBaseId: 'library-1' } } },
  library: { id: 'library-1', enterprise: { accessLevel: 'edit', ownerName: 'Owner' } },
}));
vi.mock('@/services/enterpriseKnowledge', () => ({
  enterpriseKnowledgeService: { resolveLevel: fixtures.resolveLevel },
}));
vi.mock('@/features/ResourceManager/hooks/useKnowledgeItem', () => ({
  useKnowledgeBaseItem: vi.fn(),
}));
vi.mock('@/features/ResourceManager/store', () => ({ useResourceManagerStore: () => undefined }));
vi.mock('@/store/document', () => ({
  useDocumentStore: (selector: (state: unknown) => unknown) =>
    selector({ documentDetailMap: fixtures.documents }),
}));
vi.mock('@/store/library', async () => ({
  ...(await import('@/store/library/slices/crud/selectors')),
  useKnowledgeBaseStore: (selector: (state: unknown) => unknown) =>
    selector({
      knowledgeBaseDetailMap: { 'library-1': fixtures.library },
      knowledgeBaseListMap: {},
      knowledgeBaseSessionAccess: {},
    }),
}));
vi.mock('@/hooks/usePermission', () => ({ usePermission: () => ({ allowed: true }) }));

const wrapper = ({ children }: PropsWithChildren) =>
  createElement(
    SWRConfig,
    {
      value: { provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false },
    },
    children,
  );

describe('document node permission resolution', () => {
  beforeEach(() => {
    const scope = `document-node-${crypto.randomUUID()}`;
    vi.spyOn(cacheScope, 'get').mockReturnValue(scope);
    vi.spyOn(cacheScope, 'use').mockReturnValue(scope);
    vi.spyOn(cacheScope, 'canPersist').mockReturnValue(false);
    enterpriseKnowledgeActions.reset();
  });
  afterEach(() => {
    cleanup();
    enterpriseKnowledgeActions.reset();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('stays read-only while unresolved, then enables editing when the real replica resolves edit', async () => {
    let resolve!: (value: { level: 'edit' }) => void;
    fixtures.resolveLevel.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const { result } = renderHook(() => useDocumentLibraryPermission('document-1'), { wrapper });
    expect(result.current.allowed).toBe(false);
    await waitFor(() => expect(resolve).toBeDefined());
    await act(async () => {
      resolve({ level: 'edit' });
    });
    await waitFor(() => expect(result.current.allowed).toBe(true));
    expect(
      useEnterpriseKnowledgeStore.getState().nodeLevelMap[
        JSON.stringify(['library-1', 'document-1'])
      ],
    ).toEqual({ level: 'edit' });
  });

  it.each(['view', 'path'] as const)(
    'keeps the document read-only when the node resolves %s despite library edit',
    async (level) => {
      fixtures.resolveLevel.mockResolvedValue({ level });
      const { result } = renderHook(() => useDocumentLibraryPermission('document-1'), { wrapper });
      await waitFor(() => expect(result.current.level).toBe(level));
      expect(result.current.allowed).toBe(false);
    },
  );
});

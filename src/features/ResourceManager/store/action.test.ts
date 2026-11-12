import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { enterpriseKnowledgeService } from '@/services/enterpriseKnowledge';
import { fileService } from '@/services/file';
import { initialState as fileInitialState } from '@/store/file/initialState';
import { useFileStore } from '@/store/file/store';
import { initialState as libraryInitialState } from '@/store/library/initialState';
import { useKnowledgeBaseStore } from '@/store/library/store';
import type { KnowledgeBaseItem } from '@/types/knowledgeBase';
import type { ResourceItem } from '@/types/resource';

import { useResourceManagerStore } from '.';
import { initialState } from './initialState';
import { explorerSearchResource } from './projection';

const {
  mockDeleteResourcesByQuery,
  mockDropNodes,
  mockForgetSnapshot,
  mockResolveSelectionIds,
  mockRevalidateTree,
} = vi.hoisted(() => ({
  mockDeleteResourcesByQuery: vi.fn(),
  mockDropNodes: vi.fn(async () => undefined),
  mockForgetSnapshot: vi.fn(),
  mockResolveSelectionIds: vi.fn(),
  mockRevalidateTree: vi.fn(async () => undefined),
}));

vi.mock('@/store/tree', () => ({
  useTreeStore: {
    getState: () => ({
      dropNodes: mockDropNodes,
      forgetSnapshot: mockForgetSnapshot,
      revalidate: mockRevalidateTree,
    }),
  },
}));

vi.mock('@/services/resource', () => ({
  resourceService: {
    deleteResourcesByQuery: mockDeleteResourcesByQuery,
    resolveSelectionIds: mockResolveSelectionIds,
  },
}));

const enterpriseLibrary: KnowledgeBaseItem = {
  avatar: null,
  createdAt: new Date(0),
  enterprise: { accessLevel: 'owner', ownerName: 'Owner' },
  id: 'kb-ent',
  isPublic: false,
  name: 'Enterprise',
  settings: {},
  type: null,
  updatedAt: new Date(0),
};

describe('resource manager store actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    useResourceManagerStore.setState(initialState);
    useFileStore.setState(fileInitialState);
    useKnowledgeBaseStore.setState(libraryInitialState);
  });
  afterEach(() => vi.restoreAllMocks());

  it.each(['delete', 'batchChunking'] as const)(
    'resolves a directory slug before enterprise %s permission checks',
    async (action) => {
      const slug = 'information-sunlight-mistake';
      const ids = ['file_a', 'file_b'];
      const mutate = vi.fn(async () => undefined);
      const permission = vi
        .spyOn(enterpriseKnowledgeService, 'canEditNodes')
        .mockImplementation(async (_kb, nodeIds) => nodeIds.every((id) => id !== slug));
      vi.spyOn(fileService, 'getFolderBreadcrumb').mockResolvedValue([
        { id: 'docs_directory', name: 'Directory', slug },
      ]);
      useKnowledgeBaseStore.setState({
        knowledgeBaseDetailMap: {
          'kb-ent': enterpriseLibrary,
        },
      });
      useResourceManagerStore.setState({
        libraryId: 'kb-ent',
        selectedFileIds: ids,
        selectAllState: 'loaded',
      });
      useFileStore.setState({
        deleteResources: mutate,
        parseFilesToChunks: mutate,
        queryParams: { parentId: slug },
        resourceMap: new Map(
          ids.map((id) => [
            id,
            {
              createdAt: new Date(0),
              fileType: 'text/plain',
              id,
              name: `${id}.txt`,
              size: 10,
              sourceType: 'file',
              updatedAt: new Date(0),
            },
          ]),
        ),
      });
      await useResourceManagerStore.getState().onActionClick(action);
      expect(permission).toHaveBeenCalledWith('kb-ent', ['docs_directory', ...ids]);
      if (action === 'delete') expect(mutate).toHaveBeenCalledWith(ids);
      else expect(mutate).toHaveBeenCalledWith(ids, { skipExist: true });
    },
  );

  it('does not treat an unresolved non-root directory as the enterprise library root', async () => {
    const mutate = vi.fn();
    const permission = vi.spyOn(enterpriseKnowledgeService, 'canEditNodes').mockResolvedValue(true);
    vi.spyOn(fileService, 'getFolderBreadcrumb').mockResolvedValue([]);
    useKnowledgeBaseStore.setState({
      knowledgeBaseDetailMap: {
        'kb-ent': enterpriseLibrary,
      },
    });
    useResourceManagerStore.setState({
      libraryId: 'kb-ent',
      selectedFileIds: ['file_a'],
      selectAllState: 'loaded',
    });
    useFileStore.setState({
      deleteResources: mutate,
      queryParams: { parentId: 'missing-folder' },
    });
    await expect(useResourceManagerStore.getState().onActionClick('delete')).rejects.toThrow();
    expect(permission).not.toHaveBeenCalled();
    expect(mutate).not.toHaveBeenCalled();
  });

  it.each([
    [null, null],
    ['docs_directory', 'docs_directory'],
    ['cached-directory', 'docs_cached'],
  ])(
    'keeps the permission boundary for parent %s and blocks a denied deletion',
    async (parentId, nodeId) => {
      const mutate = vi.fn();
      const permission = vi
        .spyOn(enterpriseKnowledgeService, 'canEditNodes')
        .mockResolvedValue(false);
      const breadcrumb = vi.spyOn(fileService, 'getFolderBreadcrumb');
      useKnowledgeBaseStore.setState({
        knowledgeBaseDetailMap: {
          'kb-ent': enterpriseLibrary,
        },
      });
      useResourceManagerStore.setState({
        libraryId: 'kb-ent',
        selectedFileIds: ['file_a'],
        selectAllState: 'loaded',
      });
      useFileStore.setState({
        deleteResources: mutate,
        folderBreadcrumbMap: {
          'cached-directory': [{ id: 'docs_cached', name: 'Cached', slug: 'cached-directory' }],
        },
        queryParams: { parentId },
      });
      await useResourceManagerStore.getState().onActionClick('delete');
      expect(permission).toHaveBeenCalledWith('kb-ent', [nodeId, 'file_a']);
      expect(breadcrumb).not.toHaveBeenCalled();
      expect(mutate).not.toHaveBeenCalled();
    },
  );

  it('should default workspace resources to workspace mode when no preference is persisted', () => {
    useResourceManagerStore.setState({
      listVisibility: 'private',
      selectAllState: 'loaded',
      selectedFileIds: ['file-1'],
    });

    useResourceManagerStore.getState().hydrateListVisibility('workspace-1');

    expect(useResourceManagerStore.getState()).toMatchObject({
      listVisibility: 'workspace',
      selectAllState: 'none',
      selectedFileIds: [],
    });
  });

  it('should restore the persisted private mode over the workspace default', () => {
    useResourceManagerStore.getState().setListVisibility('private', 'workspace-1');
    useResourceManagerStore.setState({ listVisibility: 'workspace' });

    useResourceManagerStore.getState().hydrateListVisibility('workspace-1');

    expect(useResourceManagerStore.getState().listVisibility).toBe('private');
  });

  it('should drop the previous source rows when the source filter changes', () => {
    // Regression: the pick used to update ResourceManager state only, leaving
    // the previous source's rows on screen and interactive until the fetch
    // landed — and a "select all" fired in that window resolved against the
    // stale queryParams, so the next batch action targeted the wrong source.
    useFileStore.setState({
      queryParams: { category: 'images', sourceFilter: 'generated' } as any,
      resourceList: [{ id: 'file-1' }, { id: 'file-2' }] as any,
      resourceMap: new Map([['file-1', { id: 'file-1' } as any]]),
      selectAllState: 'all',
    } as any);
    useResourceManagerStore.setState({
      selectAllState: 'all',
      selectedFileIds: ['file-9'],
      selectionTotal: 12,
      sourceFilter: 'generated' as any,
    });

    useResourceManagerStore.getState().setSourceFilter('uploaded' as any);

    expect(useResourceManagerStore.getState()).toMatchObject({
      selectAllState: 'none',
      selectedFileIds: [],
      sourceFilter: 'uploaded',
    });
    expect(useResourceManagerStore.getState().selectionTotal).toBeUndefined();
    expect(useFileStore.getState().resourceList).toEqual([]);
  });

  it('should ignore re-picking the already active source filter', () => {
    useFileStore.setState({ resourceList: [{ id: 'file-1' }] as any } as any);
    useResourceManagerStore.setState({ sourceFilter: 'uploaded' as any });

    useResourceManagerStore.getState().setSourceFilter('uploaded' as any);

    // No clear, so clicking the active chip does not flash the list.
    expect(useFileStore.getState().resourceList).toEqual([{ id: 'file-1' }]);
  });

  it('should exclude deselected ids when resolving all-selected resources', async () => {
    useResourceManagerStore.setState({
      selectAllState: 'all',
      selectedFileIds: ['file-2'],
    });
    useFileStore.setState({
      queryParams: { q: 'report' } as any,
    });
    mockResolveSelectionIds.mockResolvedValue({
      ids: ['file-1', 'file-2', 'file-3'],
    });

    const result = await useResourceManagerStore.getState().resolveSelectedResourceIds();

    expect(mockResolveSelectionIds).toHaveBeenCalledWith({ q: 'report' });
    expect(result).toEqual(['file-1', 'file-3']);
  });

  it('should store the role-scoped total when selecting every query result', async () => {
    useFileStore.setState({ queryParams: { q: 'report' } as any });
    mockResolveSelectionIds.mockResolvedValue({ ids: ['file-1', 'file-2'], total: 2 });

    await useResourceManagerStore.getState().selectAllResources();

    expect(mockResolveSelectionIds).toHaveBeenCalledWith({ q: 'report' });
    expect(useResourceManagerStore.getState()).toMatchObject({
      selectAllState: 'all',
      selectedFileIds: [],
      selectionTotal: 2,
    });
  });

  it('should keep all-selected deletion caller-scoped when exclusions are present', async () => {
    const deleteResources = vi.fn().mockResolvedValue(undefined);
    const evictResourceLists = vi.fn().mockResolvedValue(undefined);

    useResourceManagerStore.setState({
      selectAllState: 'all',
      selectedFileIds: ['file-2'],
    });
    useFileStore.setState({
      deleteResources,
      evictResourceLists,
      queryParams: { q: 'report' } as any,
    });
    mockDeleteResourcesByQuery.mockResolvedValue({ count: 2 });

    await useResourceManagerStore.getState().onActionClick('delete');

    expect(mockDeleteResourcesByQuery).toHaveBeenCalledWith({ q: 'report' }, ['file-2']);
    expect(mockResolveSelectionIds).not.toHaveBeenCalled();
    expect(deleteResources).not.toHaveBeenCalled();
    expect(evictResourceLists).toHaveBeenCalledTimes(1);
    expect(useResourceManagerStore.getState()).toMatchObject({
      selectAllState: 'none',
      selectedFileIds: [],
      selectionTotal: undefined,
    });
  });

  // Regression: the explorer's own list is optimistic, but the sidebar tree
  // keeps a separate per-folder cache that the bulk delete never touched, so
  // deleted rows stayed in the sidebar until a full reload.
  it('should drop the deleted rows from the sidebar tree', async () => {
    const deleteResources = vi.fn().mockResolvedValue(undefined);

    useResourceManagerStore.setState({
      selectAllState: 'loaded',
      selectedFileIds: ['file-1', 'file-2'],
    });
    useFileStore.setState({
      deleteResources,
      queryParams: { parentId: 'folder-a' } as any,
    } as any);

    await useResourceManagerStore.getState().onActionClick('delete');

    expect(deleteResources).toHaveBeenCalledWith(['file-1', 'file-2']);
    expect(mockDropNodes).toHaveBeenCalledWith(['file-1', 'file-2'], 'folder-a');
  });

  // Regression: the explorer's search overlay mirrors cached replica pages, so
  // a deleted hit kept showing there (and came back after a reload) until the
  // row was dropped from the cache as part of the delete.
  it('should drop the deleted rows from the cached explorer searches', async () => {
    const params = { pageSize: 50, q: 'report' } as any;
    const key = explorerSearchResource.key(params);
    const row = (id: string): ResourceItem => ({ fileType: 'custom/document', id, name: id });

    useResourceManagerStore.setState({
      explorerSearchEntries: {
        [key]: {
          currentPage: 0,
          hasMore: false,
          items: [row('file-1'), row('file-2')],
          pageSize: 50,
          searchParams: params,
          total: 2,
        },
      },
      selectAllState: 'loaded',
      selectedFileIds: ['file-1'],
    });
    useFileStore.setState({
      deleteResources: vi.fn().mockResolvedValue(undefined),
      queryParams: { parentId: 'folder-a' } as any,
    } as any);

    await useResourceManagerStore.getState().onActionClick('delete');

    const entry = useResourceManagerStore.getState().explorerSearchEntries[key];
    expect(entry?.items.map((item) => item.id)).toEqual(['file-2']);
    expect(entry?.total).toBe(1);
  });

  it('should drop the cached explorer searches when the deleted set is server-only', async () => {
    const params = { pageSize: 50, q: 'report' } as any;
    const key = explorerSearchResource.key(params);

    useResourceManagerStore.setState({
      explorerSearchEntries: {
        [key]: {
          currentPage: 0,
          hasMore: false,
          items: [{ fileType: 'custom/document', id: 'file-1', name: 'file-1' }],
          pageSize: 50,
          searchParams: params,
          total: 1,
        },
      },
      selectAllState: 'all',
      selectedFileIds: [],
    });
    useFileStore.setState({
      deleteResources: vi.fn(),
      evictResourceLists: vi.fn().mockResolvedValue(undefined),
      queryParams: { parentId: 'folder-a' } as any,
    } as any);
    mockDeleteResourcesByQuery.mockResolvedValue({ count: 1 });

    await useResourceManagerStore.getState().onActionClick('delete');

    // No id is known client-side, so the cached searches are dropped whole and
    // the refetch paints whatever survived.
    expect(useResourceManagerStore.getState().explorerSearchEntries[key]).toBeUndefined();
  });

  it('should refresh the listed folder when the deleted set is only known to the server', async () => {
    useResourceManagerStore.setState({ selectAllState: 'all', selectedFileIds: [] });
    useFileStore.setState({
      deleteResources: vi.fn(),
      evictResourceLists: vi.fn().mockResolvedValue(undefined),
      queryParams: { parentId: 'folder-a' } as any,
    } as any);
    mockDeleteResourcesByQuery.mockResolvedValue({ count: 3 });

    await useResourceManagerStore.getState().onActionClick('delete');

    // Individual ids never reach the client here, so the whole folder is refetched.
    expect(mockRevalidateTree).toHaveBeenCalledWith('folder-a');
    expect(mockDropNodes).not.toHaveBeenCalled();
    // A refetch that never lands must not leave the deleted rows in the persisted tree.
    expect(mockForgetSnapshot).toHaveBeenCalledTimes(1);
  });
});

describe('library sidebar search', () => {
  beforeEach(() => {
    useResourceManagerStore.setState(initialState);
  });

  it('should store the sidebar search query', () => {
    useResourceManagerStore.getState().setLibrarySearchQuery('weekly');

    expect(useResourceManagerStore.getState().librarySearchQuery).toBe('weekly');
  });

  it('should reset the sidebar search query when switching library', () => {
    useResourceManagerStore.setState({ libraryId: 'kb-1', librarySearchQuery: 'weekly' });

    useResourceManagerStore.getState().setLibraryId('kb-2');

    expect(useResourceManagerStore.getState()).toMatchObject({
      libraryId: 'kb-2',
      librarySearchQuery: '',
    });
  });

  it('should keep the sidebar search query when the same library is re-synced from the URL', () => {
    useResourceManagerStore.setState({ libraryId: 'kb-1', librarySearchQuery: 'weekly' });

    useResourceManagerStore.getState().setLibraryId('kb-1');

    expect(useResourceManagerStore.getState().librarySearchQuery).toBe('weekly');
  });
});

describe('pending tree rename', () => {
  beforeEach(() => {
    useResourceManagerStore.setState(initialState);
  });

  it('should set and clear the pending tree rename item id', () => {
    useResourceManagerStore.getState().setPendingTreeRenameItemId('folder-1');
    expect(useResourceManagerStore.getState().pendingTreeRenameItemId).toBe('folder-1');

    useResourceManagerStore.getState().setPendingTreeRenameItemId(null);
    expect(useResourceManagerStore.getState().pendingTreeRenameItemId).toBeNull();
  });
});

import { cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { type ReactNode, useEffect } from 'react';
import { SWRConfig, useSWRConfig } from 'swr';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { usePageLibraryPermission } from '@/features/EnterpriseKnowledge/usePageLibraryPermission';
import PageExplorer from '@/features/PageExplorer';
import { cacheScope } from '@/libs/replica';
import { setScopedMutate } from '@/libs/swr/mutate';
import { documentService } from '@/services/document';
import { useKnowledgeBaseStore } from '@/store/library';
import { pageActions, pageSelectors, usePageStore } from '@/store/page';
import { DocumentSourceType, type LobeDocument } from '@/types/document';

import { PageEditor } from './PageEditor';
import { usePageEditorStore } from './store';
import { getTitleTextAreaInteractionProps, isTitleSubmitKey } from './TitleSection';

vi.mock('@/features/PageEditor', () => ({
  PageEditor: ({
    onTitleChange,
    onEmojiChange,
  }: {
    onTitleChange?: (title: string) => void;
    onEmojiChange?: (emoji: string) => void;
  }) => (
    <>
      <button onClick={() => onTitleChange?.('Saved title')}>Notify saved title</button>
      <button onClick={() => onEmojiChange?.('📄')}>Notify saved emoji</button>
    </>
  ),
}));

describe('PageExplorer metadata save notifications', () => {
  const document: LobeDocument = {
    content: 'Saved body',
    createdAt: new Date('2026-10-10T12:00:00Z'),
    editorData: null,
    fileType: 'custom/document',
    filename: 'Old title',
    id: 'docs_notification',
    metadata: {},
    source: 'document',
    sourceType: DocumentSourceType.EDITOR,
    title: 'Old title',
    totalCharCount: 10,
    totalLineCount: 1,
    updatedAt: new Date('2026-10-10T12:00:00Z'),
  };

  const QueryHarness = () => {
    const { mutate } = useSWRConfig();
    useEffect(() => setScopedMutate(mutate), [mutate]);
    pageActions.useFetchDocuments();
    return <PageExplorer pageId={document.id} />;
  };

  const renderPage = () =>
    render(
      <SWRConfig
        value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}
      >
        <QueryHarness />
      </SWRConfig>,
    );
  const currentPage = () => pageSelectors.getDocumentById(document.id)(usePageStore.getState());

  beforeEach(() => {
    pageActions.reset();
    const scope = `page-notification-${crypto.randomUUID()}`;
    vi.spyOn(cacheScope, 'get').mockReturnValue(scope);
    vi.spyOn(cacheScope, 'use').mockReturnValue(scope);
    vi.spyOn(cacheScope, 'canPersist').mockReturnValue(false);
  });

  afterEach(() => {
    cleanup();
    pageActions.reset();
    vi.restoreAllMocks();
  });

  it.each(['title', 'emoji'])(
    'refreshes a saved %s without persisting a second update',
    async (field) => {
      const saved = { ...document, metadata: { emoji: '📄' }, title: 'Saved title' };
      const writes = vi.spyOn(documentService, 'updateDocument').mockResolvedValue({});
      const detail = vi
        .spyOn(documentService, 'getDocumentById')
        .mockResolvedValue(document as any);
      const list = vi
        .spyOn(documentService, 'queryDocuments')
        .mockResolvedValue({ items: [document], total: 1 } as any);
      renderPage();
      await waitFor(() => expect(currentPage()?.title).toBe('Old title'));
      detail.mockResolvedValue(saved as any);
      list.mockResolvedValue({ items: [saved], total: 1 } as any);
      fireEvent.click(screen.getByRole('button', { name: `Notify saved ${field}` }));

      await waitFor(() => {
        expect(currentPage()?.title).toBe('Saved title');
        expect(currentPage()?.metadata?.emoji).toBe('📄');
      });
      expect(writes).not.toHaveBeenCalled();
    },
  );

  it('keeps the saved page when its list refresh fails without another write', async () => {
    const saved = { ...document, title: 'Saved title' };
    const error = new Error('Page list unavailable');
    const writes = vi.spyOn(documentService, 'updateDocument').mockResolvedValue({});
    vi.spyOn(documentService, 'getDocumentById').mockResolvedValue(saved as any);
    const list = vi
      .spyOn(documentService, 'queryDocuments')
      .mockResolvedValue({ items: [saved], total: 1 } as any);
    renderPage();
    await waitFor(() => expect(currentPage()?.title).toBe('Saved title'));
    const initialReads = list.mock.calls.length;
    list.mockRejectedValue(error);
    fireEvent.click(screen.getByRole('button', { name: 'Notify saved title' }));

    await waitFor(() => expect(list.mock.calls.length).toBeGreaterThan(initialReads));
    expect(currentPage()?.title).toBe('Saved title');
    expect(writes).not.toHaveBeenCalled();
  });
});

describe('PageEditor title interaction', () => {
  it('keeps a non-editable title visually enabled but read-only', () => {
    const props = getTitleTextAreaInteractionProps(false);

    expect(props).toEqual({ readOnly: true });
    expect(props).not.toHaveProperty('disabled');
    expect(getTitleTextAreaInteractionProps(true)).toEqual({ readOnly: false });
  });

  it('submits the title on a plain Enter', () => {
    expect(
      isTitleSubmitKey({ key: 'Enter', keyCode: 13, nativeEvent: { isComposing: false } }),
    ).toBe(true);
    expect(isTitleSubmitKey({ key: 'a', keyCode: 65, nativeEvent: { isComposing: false } })).toBe(
      false,
    );
  });

  it('ignores Enter that confirms an IME composition', () => {
    expect(
      isTitleSubmitKey({ key: 'Enter', keyCode: 13, nativeEvent: { isComposing: true } }),
    ).toBe(false);
    // Safari fires the confirming keydown after compositionend with keyCode 229
    expect(
      isTitleSubmitKey({ key: 'Enter', keyCode: 229, nativeEvent: { isComposing: false } }),
    ).toBe(false);
  });
});

describe('PageEditor beforeunload handler', () => {
  let addEventListenerSpy: ReturnType<typeof vi.spyOn>;
  let removeEventListenerSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    addEventListenerSpy = vi.spyOn(window, 'addEventListener');
    removeEventListenerSpy = vi.spyOn(window, 'removeEventListener');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should call preventDefault when isDirty is true', () => {
    const preventDefaultMock = vi.fn();
    const handleBeforeUnload = vi.fn((e: BeforeUnloadEvent) => {
      const isDirty = true;
      if (isDirty) {
        e.preventDefault();
        preventDefaultMock();
      }
    });

    window.addEventListener('beforeunload', handleBeforeUnload);

    const event = new Event('beforeunload') as BeforeUnloadEvent;
    window.dispatchEvent(event);

    expect(handleBeforeUnload).toHaveBeenCalled();
    expect(preventDefaultMock).toHaveBeenCalled();

    window.removeEventListener('beforeunload', handleBeforeUnload);
  });

  it('should not call preventDefault when isDirty is false', () => {
    const preventDefaultMock = vi.fn();
    const handleBeforeUnload = vi.fn((e: BeforeUnloadEvent) => {
      const isDirty = false;
      if (isDirty) {
        e.preventDefault();
        preventDefaultMock();
      }
    });

    window.addEventListener('beforeunload', handleBeforeUnload);

    const event = new Event('beforeunload') as BeforeUnloadEvent;
    window.dispatchEvent(event);

    expect(handleBeforeUnload).toHaveBeenCalled();
    expect(preventDefaultMock).not.toHaveBeenCalled();

    window.removeEventListener('beforeunload', handleBeforeUnload);
  });

  it('should add and remove event listener through useEffect', () => {
    const { unmount } = renderHook(() =>
      useEffect(() => {
        const handleBeforeUnload = (e: BeforeUnloadEvent) => {
          e.preventDefault();
        };

        window.addEventListener('beforeunload', handleBeforeUnload);

        return () => {
          window.removeEventListener('beforeunload', handleBeforeUnload);
        };
      }, []),
    );

    expect(addEventListenerSpy).toHaveBeenCalledWith('beforeunload', expect.any(Function));

    unmount();

    expect(removeEventListenerSpy).toHaveBeenCalledWith('beforeunload', expect.any(Function));
  });
});

// Keep the real PageEditor, PageEditorProvider, Zustand context and permission hooks.
// Replace editor/network side effects and unrelated visual children only.
vi.mock('@lobehub/editor/react', () => ({
  DEFAULT_BLOCK_ANCHOR_PADDING: 16,
  EditorProvider: ({ children }: { children: ReactNode }) => children,
  useEditor: () => undefined,
}));
vi.mock('./store/action', () => ({ store: (initial: object) => () => initial }));
vi.mock('./StoreUpdater', () => ({ default: () => null }));
vi.mock('./PageAgentProvider', () => ({
  PageAgentProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('@/features/ResourceManager/hooks/useKnowledgeItem', () => ({
  useKnowledgeBaseItem: vi.fn(),
}));
vi.mock('./usePageEditable', () => ({
  usePageEditable: () => usePageLibraryPermission('edit_own_content').allowed,
}));
vi.mock('@/hooks/useHotkeys', () => ({ useRegisterFilesHotkeys: vi.fn() }));
vi.mock('@/features/WideScreenContainer', () => ({
  default: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('./DocumentComments/context', () => ({
  DocumentCommentsProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('./DocumentComments/Gutter/useGutterLayout', () => ({
  GUTTER_COLUMN_ATTRIBUTE: 'data-gutter',
}));
vi.mock('./HtmlPageBody', () => ({ default: () => null, useIsHtmlPage: () => false }));
vi.mock('./EditorCanvas', () => ({
  default: function EditorCanvasProbe() {
    const documentId = usePageEditorStore((s) => s.documentId);
    const onSave = usePageEditorStore((s) => s.onSave);
    return <button onClick={onSave}>Save {documentId}</button>;
  },
}));
vi.mock('./Header', () => ({ default: () => null }));
vi.mock('./TitleSection', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  default: () => null,
}));
vi.mock('./PageMetaBar', () => ({ default: () => null }));
vi.mock('./LockStatusBanner', () => ({ default: () => null }));
vi.mock('./LockedAlert', () => ({ default: () => null }));
vi.mock('./DocumentLikes', () => ({ default: () => null }));
vi.mock('./DocumentComments', () => ({ default: () => null }));
vi.mock('./DocumentComments/BlockCommentMarker', () => ({ default: () => null }));
vi.mock('./DocumentComments/Gutter', () => ({ default: () => null }));
vi.mock('./TableOfContents', () => ({ default: () => null }));
vi.mock('./RightPanel', () => ({ default: () => null }));
vi.mock('@/features/EditorCanvas/DiffAllToolbar', () => ({ default: () => null }));

describe('PageEditor provider boundary', () => {
  beforeEach(() => {
    useKnowledgeBaseStore.setState({
      knowledgeBaseDetailMap: Object.fromEntries(
        (['edit', 'view'] as const).map((level) => [
          level + '-library',
          {
            avatar: null,
            createdAt: new Date(0),
            updatedAt: new Date(0),
            enterprise: { accessLevel: level, ownerName: 'Owner' },
            id: level + '-library',
            isPublic: false,
            name: 'Enterprise',
            settings: {},
            type: null,
          },
        ]),
      ),
    });
  });
  it.each([undefined, 'edit-library'])(
    'mounts directly and saves with library %s',
    (knowledgeBaseId) => {
      const onSave = vi.fn();
      render(<PageEditor knowledgeBaseId={knowledgeBaseId} pageId="page-1" onSave={onSave} />);

      fireEvent.click(screen.getByRole('button', { name: 'Save page-1' }));
      expect(onSave).toHaveBeenCalledOnce();
    },
  );

  it('keeps the outer callback guarded by the opened library permission', () => {
    const onSave = vi.fn();
    render(<PageEditor knowledgeBaseId="view-library" pageId="page-1" onSave={onSave} />);

    fireEvent.click(screen.getByRole('button', { name: 'Save page-1' }));
    expect(onSave).not.toHaveBeenCalled();
  });
});

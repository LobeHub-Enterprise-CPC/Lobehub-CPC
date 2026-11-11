import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import DocumentBody from './Body';
import { DocumentViewProvider } from './documentViewContext';

vi.mock('@/features/FileViewer/FileDocumentPreview', () => ({
  FileDocumentPreview: ({ fileId }: { fileId?: string | null }) => (
    <div data-file-id={fileId} data-testid="original-file-preview" />
  ),
}));

vi.mock('@lobehub/ui', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;

  return {
    ...actual,
    createStaticStyles: () => ({
      content: 'content',
    }),
    cssVar: {
      colorBgContainer: 'var(--color-bg-container)',
      colorBorderSecondary: 'var(--color-border-secondary)',
      colorTextSecondary: 'var(--color-text-secondary)',
      fontFamilyCode: 'monospace',
    },
  };
});

vi.mock('@/components/CodeEditorPane', () => ({
  default: ({
    onChange,
    onSave,
    value,
  }: {
    onChange?: (next: string) => void;
    onSave?: () => void;
    value: string;
  }) => (
    <textarea
      data-testid="highlight-editor"
      value={value}
      onChange={(event) => onChange?.(event.target.value)}
      onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === 's') {
          event.preventDefault();
          onSave?.();
        }
      }}
    />
  ),
}));

const mockDocumentMeta = vi.hoisted(() => ({
  current: { content: '', filename: 'doc.md' } as {
    content?: string;
    fileId?: string | null;
    sourceType?: string;
    fileType?: string | null;
    filename?: string | null;
    title?: string | null;
  },
}));

const mockDocumentError = vi.hoisted(() => ({ current: undefined as Error | undefined }));
/** The persisted row has been read; `false` = the replica is still hydrating. */
const mockDocumentHydrated = vi.hoisted(() => ({ current: true }));

const mockUpdateDocument = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('@/services/document', () => ({
  documentService: {
    getDocumentById: vi.fn(),
    updateDocument: mockUpdateDocument,
  },
}));

vi.mock('./EditorCanvas', () => ({
  default: () => <div data-testid="editor-canvas" />,
}));

vi.mock('./TodoList', () => ({
  default: () => <div data-testid="todo-list" />,
}));

vi.mock('@/features/FloatingChatPanel', () => ({
  default: () => <div data-testid="floating-chat-panel" />,
}));

const mockChatState = vi.hoisted(() => ({
  current: {
    activeTopicId: 'topic-1',
    portalStack: [
      {
        agentDocumentId: 'agent-document-1' as string | undefined,
        documentId: 'document-1',
        type: 'document',
      },
    ],
  },
}));

vi.mock('@/store/chat', () => ({
  useChatStore: (selector: any) => selector(mockChatState.current),
}));

const mockAgentState = vi.hoisted(() => ({
  current: {
    activeAgentId: 'agent-1' as string | undefined,
  },
}));

vi.mock('@/store/agent', () => ({
  useAgentStore: (selector: any) => selector(mockAgentState.current),
}));

const mockDocumentState = vi.hoisted(() => ({
  current: {
    documentDetailMap: {} as Record<string, { document: { knowledgeBaseId: string } }>,
    documents: {
      'document-1': {},
    },
    internal_dispatchDocument: vi.fn(),
    beginDocumentDetailPatch: vi.fn(() => vi.fn()),
    performSave: vi.fn(),
    updateSkillFrontmatter: vi.fn(),
    // The document's replica entry, as the store's read hook reports it.
    useFetchDocumentDetail: vi.fn(() => ({
      data: mockDocumentMeta.current,
      error: mockDocumentError.current,
      isHydrated: mockDocumentHydrated.current,
      isLoading: mockDocumentMeta.current === undefined && !mockDocumentError.current,
      isValidating: false,
      mutate: vi.fn(),
    })),
  },
}));

vi.mock('@/store/document', () => ({
  useDocumentStore: (selector: any) => selector(mockDocumentState.current),
}));

describe('DocumentBody', () => {
  afterEach(() => {
    mockDocumentError.current = undefined;
    mockDocumentHydrated.current = true;
  });

  it('paints nothing while the persisted document is still being read', () => {
    mockDocumentMeta.current = undefined as never;
    mockDocumentHydrated.current = false;

    const { container } = render(<DocumentBody />);

    expect(container).toBeEmptyDOMElement();
  });

  /** @example A file-backed document previews its upload and keeps the portal actions. */
  it('shows the original upload without mounting either editor', () => {
    // ROOT CAUSE:
    // File-backed documents used the empty content field as an editable document.
    // Selecting a file preview must not mount an editor that could save this empty copy.
    mockDocumentMeta.current = { content: '', fileId: 'file-original', filename: 'source.unknown' };
    render(<DocumentBody />);
    /** @example The original file id reaches the read-only preview. */
    expect(screen.getByTestId('original-file-preview').dataset.fileId).toBe('file-original');
    /** @example Neither editor mounts. */
    expect(screen.queryByTestId('highlight-editor')).toBeNull();
    expect(screen.queryByTestId('editor-canvas')).toBeNull();
  });

  beforeEach(() => {
    mockAgentState.current.activeAgentId = 'agent-1';
    mockChatState.current.portalStack[0].agentDocumentId = 'agent-document-1';
    mockDocumentMeta.current = { content: '', filename: 'doc.md' };
    mockDocumentState.current.documents = { 'document-1': {} };
    mockDocumentState.current.documentDetailMap = {};
    mockLibraryState.current.knowledgeBaseDetailMap = {};
    mockLibraryState.current.knowledgeBaseSessionAccess = {};
    mockUpdateDocument.mockClear();
    mockDocumentState.current.internal_dispatchDocument.mockClear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps the cached document on screen when the background refresh fails', () => {
    mockDocumentMeta.current = { content: 'cached log', filename: 'topic_call.txt' };
    mockDocumentError.current = new Error('Failed to fetch');

    render(<DocumentBody />);

    expect(screen.getByTestId('highlight-editor')).toHaveValue('cached log');
  });

  it('renders highlight editor for non-markdown files', () => {
    mockDocumentMeta.current = { content: 'raw log content', filename: 'topic_call.txt' };

    render(<DocumentBody />);

    expect(screen.getByTestId('highlight-editor')).toHaveValue('raw log content');
    expect(screen.queryByTestId('editor-canvas')).toBeNull();
  });

  it('renders EditorCanvas for markdown files', () => {
    mockDocumentMeta.current = { content: '# hi', filename: 'note.md' };

    render(<DocumentBody />);

    expect(screen.getByTestId('editor-canvas')).toBeDefined();
    expect(screen.queryByTestId('highlight-editor')).toBeNull();
  });

  it('renders an HTML page in a sandboxed frame without mounting either editor', () => {
    mockDocumentMeta.current = {
      content: '<!doctype html><html><body><h1>Goal report</h1></body></html>',
      fileType: 'custom/html',
      filename: 'Goal report',
      title: 'Goal report',
    };

    const { container } = render(<DocumentBody />);

    const frame = container.querySelector('iframe')!;
    expect(frame.getAttribute('srcdoc')).toContain('<h1>Goal report</h1>');
    expect(frame.getAttribute('sandbox')).not.toContain('allow-same-origin');
    expect(screen.queryByTestId('editor-canvas')).toBeNull();
    expect(screen.queryByTestId('highlight-editor')).toBeNull();
  });

  it('renders EditorCanvas for notebook documents that have no filename', () => {
    mockDocumentMeta.current = {
      content: '# notes',
      fileType: 'markdown',
      filename: null,
      title: 'Meeting notes',
    };

    render(<DocumentBody />);

    expect(screen.getByTestId('editor-canvas')).toBeDefined();
    expect(screen.queryByTestId('highlight-editor')).toBeNull();
  });

  it('autosaves highlight editor edits after the debounce window', async () => {
    mockDocumentMeta.current = { content: 'before', filename: 'config.json' };

    render(<DocumentBody />);
    const editor = screen.getByTestId('highlight-editor');

    fireEvent.change(editor, { target: { value: 'after' } });
    expect(mockUpdateDocument).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });

    expect(mockUpdateDocument).toHaveBeenCalledWith({
      content: 'after',
      id: 'document-1',
      saveSource: 'autosave',
    });
  });

  it.each(['unresolved', 'view', 'denied'] as const)(
    'keeps %s library content readable without autosave',
    async (access) => {
      mockDocumentMeta.current = { content: 'library content', filename: 'config.json' };
      mockDocumentState.current.documentDetailMap = {
        'document-1': { document: { knowledgeBaseId: 'library-1' } },
      };
      if (access === 'view') {
        mockLibraryState.current.knowledgeBaseDetailMap['library-1'] = {
          id: 'library-1',
          enterprise: { accessLevel: 'view' },
        };
      }
      if (access === 'denied') {
        mockLibraryState.current.knowledgeBaseSessionAccess['test-scope|library-1'] = 'denied';
      }
      render(<DocumentBody />);
      const editor = screen.queryByTestId('highlight-editor');
      if (editor) fireEvent.change(editor, { target: { value: 'unauthorized edit' } });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });

      expect(mockUpdateDocument).not.toHaveBeenCalled();
      expect(screen.queryByTestId('highlight-editor')).toBeNull();
      expect(screen.queryByTestId('editor-canvas')).toBeNull();
      expect(screen.getByText('library content')).toBeVisible();
    },
  );

  it('shows skill metadata without a write entry while its library is unresolved', () => {
    mockDocumentMeta.current = { content: '# Skill content', filename: 'SKILL.md' };
    mockDocumentState.current.documentDetailMap = {
      'document-1': { document: { knowledgeBaseId: 'library-1' } },
    };
    mockDocumentState.current.documents['document-1'] = {
      contentFormat: 'skillMarkdown',
      skillFrontmatter: 'name: example\ndescription: Example skill',
    };
    render(<DocumentBody />);

    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByTestId('editor-canvas')).toBeNull();
    expect(screen.getByText('Example skill')).toBeVisible();
  });

  it('preserves skill metadata editing for an allowed personal document', () => {
    mockDocumentMeta.current = { content: '# Skill content', filename: 'SKILL.md' };
    mockDocumentState.current.documents['document-1'] = {
      contentFormat: 'skillMarkdown',
      skillFrontmatter: 'name: example\ndescription: Example skill',
    };
    render(<DocumentBody />);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByRole('textbox')).toHaveValue('name: example\ndescription: Example skill');
  });

  it('allows an enterprise edit grant to autosave', async () => {
    mockDocumentMeta.current = { content: 'before', filename: 'config.json' };
    mockDocumentState.current.documentDetailMap = {
      'document-1': { document: { knowledgeBaseId: 'library-1' } },
    };
    mockLibraryState.current.knowledgeBaseDetailMap['library-1'] = {
      id: 'library-1',
      enterprise: { accessLevel: 'edit' },
    };
    render(<DocumentBody />);
    fireEvent.change(screen.getByTestId('highlight-editor'), { target: { value: 'allowed edit' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(mockUpdateDocument).toHaveBeenCalledWith({
      content: 'allowed edit',
      id: 'document-1',
      saveSource: 'autosave',
    });
  });

  it.each(['view', 'denied'] as const)(
    'does not flush a pending edit when its library becomes %s',
    async (access) => {
      mockDocumentMeta.current = { content: 'before', filename: 'config.json' };
      mockDocumentState.current.documentDetailMap = {
        'document-1': { document: { knowledgeBaseId: 'library-1' } },
      };
      mockLibraryState.current.knowledgeBaseDetailMap['library-1'] = {
        id: 'library-1',
        enterprise: { accessLevel: 'edit' },
      };
      const { rerender } = render(
        <DocumentViewProvider value={{ documentId: 'document-1' }}>
          <DocumentBody />
        </DocumentViewProvider>,
      );
      fireEvent.change(screen.getByTestId('highlight-editor'), {
        target: { value: 'pending edit' },
      });
      if (access === 'view') {
        mockLibraryState.current.knowledgeBaseDetailMap['library-1'] = {
          id: 'library-1',
          enterprise: { accessLevel: 'view' },
        };
      } else {
        mockLibraryState.current.knowledgeBaseSessionAccess['test-scope|library-1'] = 'denied';
      }
      await act(async () => {
        rerender(
          <DocumentViewProvider value={{ documentId: 'document-1' }}>
            <DocumentBody />
          </DocumentViewProvider>,
        );
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });

      expect(screen.queryByTestId('highlight-editor')).toBeNull();
      expect(screen.getByText('before')).toBeVisible();
      expect(mockUpdateDocument).not.toHaveBeenCalled();
    },
  );

  it.each(['view', 'unresolved'] as const)(
    'flushes authorized edits for the old document when navigating to a different %s document',
    async (nextAccess) => {
      mockDocumentMeta.current = { content: 'old content', filename: 'config.json' };
      mockDocumentState.current.documentDetailMap = {
        'document-1': { document: { knowledgeBaseId: 'old-library' } },
        'document-2': { document: { knowledgeBaseId: 'next-library' } },
      };
      mockLibraryState.current.knowledgeBaseDetailMap['old-library'] = {
        id: 'old-library',
        enterprise: { accessLevel: 'edit' },
      };
      if (nextAccess === 'view') {
        mockLibraryState.current.knowledgeBaseDetailMap['next-library'] = {
          id: 'next-library',
          enterprise: { accessLevel: 'view' },
        };
      }
      const { rerender, unmount } = render(
        <DocumentViewProvider value={{ documentId: 'document-1' }}>
          <DocumentBody />
        </DocumentViewProvider>,
      );
      fireEvent.change(screen.getByTestId('highlight-editor'), {
        target: { value: 'pending authorized edit' },
      });
      mockDocumentMeta.current = { content: 'next read-only content', filename: 'config.json' };
      await act(async () => {
        rerender(
          <DocumentViewProvider value={{ documentId: 'document-2' }}>
            <DocumentBody />
          </DocumentViewProvider>,
        );
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });

      expect(screen.getByText('next read-only content')).toBeVisible();
      expect(screen.queryByTestId('highlight-editor')).toBeNull();
      expect(screen.queryByTestId('editor-canvas')).toBeNull();
      expect(mockUpdateDocument).toHaveBeenCalledExactlyOnceWith({
        content: 'pending authorized edit',
        id: 'document-1',
        saveSource: 'autosave',
      });
      await act(async () => {
        unmount();
      });
      expect(mockUpdateDocument).toHaveBeenCalledOnce();
    },
  );

  it('flushes pending highlight edits when the editor unmounts', async () => {
    mockDocumentMeta.current = { content: 'before', filename: 'config.json' };

    const { unmount } = render(<DocumentBody />);
    const editor = screen.getByTestId('highlight-editor');

    fireEvent.change(editor, { target: { value: 'after' } });
    expect(mockUpdateDocument).not.toHaveBeenCalled();

    await act(async () => {
      unmount();
    });

    expect(mockUpdateDocument).toHaveBeenCalledWith({
      content: 'after',
      id: 'document-1',
      saveSource: 'autosave',
    });
  });

  it('does not save on unmount when the highlight buffer is clean', async () => {
    mockDocumentMeta.current = { content: 'before', filename: 'config.json' };

    const { unmount } = render(<DocumentBody />);

    await act(async () => {
      unmount();
    });

    expect(mockUpdateDocument).not.toHaveBeenCalled();
  });

  it('mirrors the live highlight buffer into the document store for export', () => {
    mockDocumentMeta.current = { content: 'before', filename: 'config.json' };

    render(<DocumentBody />);
    const editor = screen.getByTestId('highlight-editor');

    // Initial mount mirrors the persisted content into the store record
    // (the mock record already exists, so this is an update).
    expect(mockDocumentState.current.internal_dispatchDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'document-1',
        type: 'updateDocument',
        value: { content: 'before' },
      }),
    );

    fireEvent.change(editor, { target: { value: 'after' } });

    // The typed buffer becomes the store content immediately, so a concurrent
    // Export downloads the text on screen instead of the last saved copy.
    expect(mockDocumentState.current.internal_dispatchDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'document-1',
        type: 'updateDocument',
        value: { content: 'after' },
      }),
    );
  });
});

// Exercise the real document -> library permission chain, including unresolved libraries.
const mockLibraryState = vi.hoisted(() => ({
  current: {
    knowledgeBaseDetailMap: {} as Record<
      string,
      { id: string; enterprise?: { accessLevel: 'view' | 'edit' | 'owner' } }
    >,
    knowledgeBaseListMap: {},
    knowledgeBaseSessionAccess: {} as Record<string, string>,
  },
}));
vi.mock('@/store/library', async () => ({
  ...(await import('@/store/library/slices/crud/selectors')),
  useKnowledgeBaseStore: (selector: (state: typeof mockLibraryState.current) => unknown) =>
    selector(mockLibraryState.current),
}));
vi.mock('@/features/ResourceManager/hooks/useKnowledgeItem', () => ({
  useKnowledgeBaseItem: vi.fn(),
}));
vi.mock('@/features/ResourceManager/store', () => ({ useResourceManagerStore: () => undefined }));
vi.mock('@/hooks/usePermission', () => ({ usePermission: () => ({ allowed: true }) }));
vi.mock('@/libs/replica', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  cacheScope: { use: () => 'test-scope' },
}));

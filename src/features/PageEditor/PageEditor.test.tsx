import { cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { SWRConfig, useSWRConfig } from 'swr';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import PageExplorer from '@/features/PageExplorer';
import { cacheScope } from '@/libs/replica';
import { setScopedMutate } from '@/libs/swr/mutate';
import { documentService } from '@/services/document';
import { pageActions, pageSelectors, usePageStore } from '@/store/page';
import { DocumentSourceType, type LobeDocument } from '@/types/document';

import { getTitleTextAreaInteractionProps } from './TitleSection';

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

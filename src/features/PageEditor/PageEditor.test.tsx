import { cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import PageExplorer from '@/features/PageExplorer';
import { documentService } from '@/services/document';
import { usePageStore } from '@/store/page';
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

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    usePageStore.setState({ documents: undefined });
  });

  it.each(['title', 'emoji'])(
    'refreshes a saved %s without persisting a second update',
    async (field) => {
      const saved = { ...document, metadata: { emoji: '📄' }, title: 'Saved title' };
      const writes = vi.spyOn(documentService, 'updateDocument').mockResolvedValue({});
      vi.spyOn(documentService, 'getPageDocuments').mockResolvedValue([saved]);
      usePageStore.setState({ documents: [document] });

      render(<PageExplorer pageId={document.id} />);
      fireEvent.click(screen.getByRole('button', { name: `Notify saved ${field}` }));

      await waitFor(() => {
        expect(usePageStore.getState().documents?.[0].title).toBe('Saved title');
        expect(usePageStore.getState().documents?.[0].metadata?.emoji).toBe('📄');
      });
      expect(writes).not.toHaveBeenCalled();
    },
  );

  it('keeps the saved page when its list refresh fails without another write', async () => {
    const saved = { ...document, title: 'Saved title' };
    const error = new Error('Page list unavailable');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const writes = vi.spyOn(documentService, 'updateDocument').mockResolvedValue({});
    vi.spyOn(documentService, 'getPageDocuments').mockRejectedValue(error);
    usePageStore.setState({ documents: [saved] });

    render(<PageExplorer pageId={document.id} />);
    fireEvent.click(screen.getByRole('button', { name: 'Notify saved title' }));

    await waitFor(() => expect(errors).toHaveBeenCalledWith('Failed to fetch documents:', error));
    expect(usePageStore.getState().documents?.[0].title).toBe('Saved title');
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

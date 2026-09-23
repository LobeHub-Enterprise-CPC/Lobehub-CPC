import { act, createEvent, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { LexicalEditor } from 'lexical';
import {
  $getRoot,
  $getSelection,
  $isRangeSelection,
  CONTROLLED_TEXT_INSERTION_COMMAND,
} from 'lexical';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { Composer } from './Composer';

// Keep the real editor, mention menu, keyboard handling and serialization.
vi.mock('@/hooks/usePermission', () => ({ usePermission: () => ({ allowed: true }) }));
vi.mock('@/hooks/useEnterToSend', () => ({
  useEnterToSend: () => (event: KeyboardEvent) => !event.shiftKey,
}));
vi.mock('@/store/global', () => ({ useGlobalStore: () => 32 }));
vi.mock('@/store/global/selectors', () => ({
  systemStatusSelectors: { chatInputHeight: () => 32 },
}));
vi.mock('@/store/serverConfig', () => ({
  featureFlagsSelectors: () => ({ enableKnowledgeBase: false }),
  useServerConfigStore: () => false,
}));
vi.mock('@/components/DragUploadZone/useLocalDragUpload', () => ({
  useLocalDragUpload: () => ({ getContainerProps: () => ({}) }),
}));
vi.mock('@/components/DragUploadZone/usePasteFile', () => ({ usePasteFile: () => {} }));
vi.mock('./useAttachments', () => ({
  useAttachments: () => ({ items: [], readyFileIds: () => [], clear: vi.fn() }),
}));
vi.mock('@/features/WideScreenContainer', () => ({
  default: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('@/features/ChatInput/Mobile/FilePreview/FileItem/File', () => ({ default: () => null }));
vi.mock('@/features/ChatInput/Mobile/FilePreview/FileItem/Image', () => ({ default: () => null }));

async function setup() {
  const onSend = vi.fn().mockResolvedValue(undefined);
  const { container } = render(
    <Composer
      members={[
        { id: 'a', name: '产品助手' },
        { id: 'b', name: '开发助手' },
        { id: 'c', name: '测试助手' },
      ]}
      onSend={onSend}
    />,
  );
  const input = container.querySelector('[contenteditable="true"]') as HTMLDivElement & {
    __lexicalEditor: LexicalEditor;
  };
  await waitFor(() => expect(input.__lexicalEditor).toBeDefined());
  const editor = input.__lexicalEditor;
  await act(async () => {
    input.focus();
    editor.update(() => $getRoot().selectEnd());
  });
  const key = async (value: string) => {
    await act(async () => {
      const event = createEvent.keyDown(input, { key: value });
      fireEvent(input, event);
      // Happy DOM has no native text input default action.
      if (!event.defaultPrevented && value.length === 1)
        editor.dispatchCommand(CONTROLLED_TEXT_INSERTION_COMMAND, value);
    });
  };
  const type = async (text: string) => {
    for (const char of text) await key(char);
  };
  const select = async (name: string) => {
    const option = await screen.findByRole('menuitem', { name });
    fireEvent.click(option);
    await waitFor(() => expect(screen.queryByRole('menuitem', { name })).toBeNull());
  };
  return { editor, input, key, onSend, select, type };
}

describe('Channel continuous mentions with the real editor', () => {
  it('keeps typing after keyboard/mouse selection and sends every selected member once', async () => {
    const { editor, key, onSend, select } = await setup();
    await key('@');
    await screen.findByRole('menuitem', { name: '产品助手' });
    await key('Enter');
    expect(onSend).not.toHaveBeenCalled();
    await waitFor(() => {
      editor.getEditorState().read(() => {
        const selection = $getSelection();
        expect($isRangeSelection(selection)).toBe(true);
        if ($isRangeSelection(selection)) {
          expect(selection.anchor.getNode().getType()).toBe('text');
          expect(selection.anchor.getNode().getTextContent()).toBe(' ');
        }
      });
    });
    await key('@');
    await select('开发助手');
    await key('@');
    await select('产品助手');
    expect(onSend).not.toHaveBeenCalled();
    await key('Enter');
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend.mock.calls[0]).toEqual([
      '@产品助手 @开发助手 @产品助手',
      ['a', 'b'],
      expect.any(String),
      'normal',
      undefined,
      [],
    ]);
  });

  it('opens after Chinese task text and punctuation without losing the task or earlier mentions', async () => {
    const { key, onSend, select, type } = await setup();
    await type('请');
    await key('@');
    await select('产品助手');
    await type('整理需求；');
    await key('@');
    await select('开发助手');
    await type('实现');
    await key('Enter');
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend.mock.calls[0].slice(0, 2)).toEqual([
      '请 @产品助手 整理需求； @开发助手 实现',
      ['a', 'b'],
    ]);
  });
});

import {
  act,
  createEvent,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import type { ComponentProps, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Composer } from './Composer';

const state = vi.hoisted(() => ({
  allowed: true,
  enableKnowledgeBase: true,
  preference: { useCmdEnterToSend: false },
  uploadWithProgress: vi.fn(),
}));

// Keep the real keyboard, paste, drag/drop and attachment hooks. Only replace the
// editor runtime and service/store boundaries; each mounted editor owns its text.
vi.mock('@lobehub/editor/react', async () => {
  const { useState } = await import('react');
  const makeEditor = () => {
    const listeners = new Set<(event: ClipboardEvent) => void>();
    const editor = {
      element: null as HTMLTextAreaElement | null,
      cleanDocument: () => {
        if (editor.element) editor.element.value = '';
      },
      getDocument: (format: string) =>
        format === 'markdown' ? (editor.element?.value ?? '') : { root: { children: [] } },
      off: (_name: string, listener: (event: ClipboardEvent) => void) => listeners.delete(listener),
      on: (_name: string, listener: (event: ClipboardEvent) => void) => listeners.add(listener),
      paste: (event: ClipboardEvent) => listeners.forEach((listener) => listener(event)),
    };
    return editor;
  };
  return {
    ChatInput: ({ children, footer }: { children: ReactNode; footer: ReactNode }) => (
      <div>
        {children}
        {footer}
      </div>
    ),
    ChatInputActionBar: ({ left, right }: { left: ReactNode; right: ReactNode }) => (
      <div>
        {left}
        {right}
      </div>
    ),
    Editor: ({
      editor,
      editable,
      onPressEnter,
      onTextChange,
      ...props
    }: {
      'aria-label': string;
      'editable': boolean;
      'editor': ReturnType<typeof makeEditor>;
      'onPressEnter': (event: { event: KeyboardEvent }) => boolean | undefined;
      'onTextChange': () => void;
    }) => (
      <textarea
        aria-label={props['aria-label']}
        readOnly={!editable}
        ref={(element) => {
          editor.element = element;
        }}
        onChange={onTextChange}
        onPaste={(event) => editor.paste(event.nativeEvent)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && onPressEnter({ event: event.nativeEvent }))
            event.preventDefault();
        }}
      />
    ),
    SendButton: ({
      disabled,
      generating,
      onSend,
      onStop,
      ...props
    }: {
      'aria-label': string;
      'disabled': boolean;
      'generating': boolean;
      'onSend': () => void;
      'onStop': () => void;
    }) => (
      <button
        aria-label={props['aria-label']}
        disabled={!generating && disabled}
        onClick={generating ? onStop : onSend}
      />
    ),
    useEditor: () => useState(makeEditor)[0],
  };
});

vi.mock('@/store/user', () => ({
  useUserStore: (select: (s: typeof state) => unknown) => select(state),
}));
vi.mock('@/store/user/selectors', () => ({
  preferenceSelectors: { useCmdEnterToSend: (s: typeof state) => s.preference.useCmdEnterToSend },
}));
vi.mock('@/store/file', () => ({
  useFileStore: (select: (s: typeof state) => unknown) => select(state),
}));
vi.mock('@/store/serverConfig', () => ({
  featureFlagsSelectors: (s: typeof state) => s,
  useServerConfigStore: (select: (s: typeof state) => unknown) => select(state),
}));
vi.mock('@/store/global', () => ({ useGlobalStore: () => 32 }));
vi.mock('@/store/global/selectors', () => ({
  systemStatusSelectors: { chatInputHeight: () => 32 },
}));
vi.mock('@/hooks/usePermission', () => ({ usePermission: () => ({ allowed: state.allowed }) }));
vi.mock('@/features/WideScreenContainer', () => ({
  default: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('@/features/ChatInput/Mobile/FilePreview/FileItem/File', () => ({
  default: ({
    file,
    status,
    onRemove,
    onRetry,
  }: {
    file: File;
    onRemove: () => void;
    onRetry: () => void;
    status: string;
  }) => (
    <div aria-label={file.name} role="group">
      <span>{status}</span>
      <button onClick={onRemove}>Remove</button>
      <button onClick={onRetry}>Retry</button>
    </div>
  ),
}));

const file = (name = 'notes.txt') => new File(['Channel attachment'], name, { type: 'text/plain' });
const transfer = (files: File[]) => ({
  items: files.map((file) => ({ kind: 'file', getAsFile: () => file })),
  types: ['Files'],
});
const pressEnter = (input: HTMLElement, options: KeyboardEventInit = {}) => {
  const event = createEvent.keyDown(input, { key: 'Enter', ...options });
  fireEvent(input, event);
  return event;
};
const drop = (input: HTMLElement, files: File[]) => {
  const event = createEvent.drop(input, { dataTransfer: transfer(files) });
  fireEvent(input, event);
  return event;
};
const setup = (props: Partial<ComponentProps<typeof Composer>> = {}) => {
  const onSend = vi.fn().mockResolvedValue(undefined);
  const view = render(<Composer members={[]} onSend={onSend} {...props} />);
  const input = screen.getByRole('textbox');
  fireEvent.change(input, { target: { value: 'A channel message' } });
  return { ...view, input, onSend };
};

beforeEach(() => {
  state.allowed = true;
  state.enableKnowledgeBase = true;
  state.preference.useCmdEnterToSend = false;
  state.uploadWithProgress.mockReset().mockResolvedValue({ id: 'attachment', url: '/attachment' });
});
afterEach(() => vi.unstubAllGlobals());

describe.each([
  ['Windows', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', { ctrlKey: true }],
  ['macOS', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', { metaKey: true }],
] as const)('%s send shortcuts', (_platform, userAgent, commandKey) => {
  beforeEach(() => vi.stubGlobal('navigator', { userAgent }));

  it('uses plain Enter by default, leaving Shift+Enter and the command shortcut to the editor', async () => {
    const { input, onSend } = setup();
    expect(pressEnter(input, { shiftKey: true }).defaultPrevented).toBe(false);
    expect(pressEnter(input, commandKey).defaultPrevented).toBe(false);
    expect(onSend).not.toHaveBeenCalled();
    expect(pressEnter(input).defaultPrevented).toBe(true);
    await waitFor(() => expect(input).toHaveValue(''));
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('honors command-Enter preference without sending during IME candidate confirmation', async () => {
    state.preference.useCmdEnterToSend = true;
    const { input, onSend } = setup();
    expect(pressEnter(input).defaultPrevented).toBe(false);
    expect(pressEnter(input, { ...commandKey, shiftKey: true }).defaultPrevented).toBe(false);
    expect(pressEnter(input, { ...commandKey, isComposing: true }).defaultPrevented).toBe(false);
    expect(onSend).not.toHaveBeenCalled();
    expect(pressEnter(input, commandKey).defaultPrevented).toBe(true);
    await waitFor(() => expect(input).toHaveValue(''));
    expect(onSend).toHaveBeenCalledTimes(1);
  });
});

it('preserves text during composition and blocks duplicate sends while awaiting success', async () => {
  const pending = Promise.withResolvers<void>();
  const onSend = vi.fn(() => pending.promise);
  const { input } = setup({ onSend });
  pressEnter(input, { isComposing: true });
  expect(onSend).not.toHaveBeenCalled();
  pressEnter(input);
  pressEnter(input);
  expect(onSend).toHaveBeenCalledTimes(1);
  expect(input).toHaveValue('A channel message');
  expect(input).toHaveAttribute('readonly');
  expect(drop(input, [file()]).defaultPrevented).toBe(true);
  await act(async () => {});
  expect(state.uploadWithProgress).not.toHaveBeenCalled();
  await act(async () => pending.resolve());
  expect(input).toHaveValue('');
  expect(input).not.toHaveAttribute('readonly');
});

it.each(['permission', 'feature flag'])(
  'still consumes file drops when uploads are blocked by %s',
  async (gate) => {
    if (gate === 'permission') state.allowed = false;
    else state.enableKnowledgeBase = false;
    const { input } = setup();
    const over = createEvent.dragOver(input, { dataTransfer: transfer([file()]) });
    fireEvent(input, over);
    expect(over.defaultPrevented).toBe(true);
    expect(drop(input, [file()]).defaultPrevented).toBe(true);
    await act(async () => {});
    expect(state.uploadWithProgress).not.toHaveBeenCalled();
  },
);

it('ignores non-file drops without consuming them', async () => {
  const { input } = setup();
  const event = createEvent.drop(input, { dataTransfer: { items: [], types: ['text/plain'] } });
  fireEvent(input, event);
  await act(async () => {});
  expect(event.defaultPrevented).toBe(false);
  expect(state.uploadWithProgress).not.toHaveBeenCalled();
});

it('blocks pending and failed attachments, retries uploads, and retains the send payload and key on failure', async () => {
  const pending = Promise.withResolvers<{ id: string; url: string }>();
  state.uploadWithProgress.mockReturnValueOnce(pending.promise);
  const { input, onSend } = setup();
  expect(drop(input, [file()]).defaultPrevented).toBe(true);
  await waitFor(() =>
    expect(screen.getByRole('group', { name: 'notes.txt' })).toHaveTextContent('pending'),
  );
  expect(screen.getByRole('button', { name: 'send' })).toBeDisabled();
  pressEnter(input);
  expect(onSend).not.toHaveBeenCalled();
  await act(async () => pending.reject(new Error('Upload failed')));
  const attachment = screen.getByRole('group', { name: 'notes.txt' });
  expect(attachment).toHaveTextContent('error');
  pressEnter(input);
  expect(onSend).not.toHaveBeenCalled();
  fireEvent.click(within(attachment).getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(attachment).toHaveTextContent('success'));

  onSend.mockRejectedValueOnce(new Error('Send failed'));
  pressEnter(input);
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('sendFailed'));
  expect(input).toHaveValue('A channel message');
  expect(attachment).toBeInTheDocument();
  const firstPayload = onSend.mock.calls[0];
  expect(firstPayload).toEqual([
    'A channel message',
    [],
    expect.any(String),
    'normal',
    undefined,
    ['attachment'],
  ]);
  fireEvent.click(screen.getByRole('button', { name: 'send' }));
  await waitFor(() => expect(input).toHaveValue(''));
  expect(onSend.mock.calls[1]).toEqual(firstPayload);
  expect(attachment).not.toBeInTheDocument();

  fireEvent.change(input, { target: { value: 'Next message' } });
  pressEnter(input);
  await waitFor(() => expect(onSend).toHaveBeenCalledTimes(3));
  expect(onSend.mock.calls[2][2]).not.toBe(firstPayload[2]);
});

it('keeps main and thread drafts isolated for dropped and pasted same-named files', async () => {
  const pending = [
    Promise.withResolvers<{ id: string; url: string }>(),
    Promise.withResolvers<{ id: string; url: string }>(),
  ];
  state.uploadWithProgress
    .mockReturnValueOnce(pending[0].promise)
    .mockReturnValueOnce(pending[1].promise);
  const mainSend = vi.fn().mockResolvedValue(undefined);
  const threadSend = vi.fn().mockResolvedValue(undefined);
  render(
    <>
      <Composer members={[]} placeholder="Main" onSend={mainSend} />
      <Composer members={[]} placeholder="Thread" onSend={threadSend} />
    </>,
  );
  const main = screen.getByRole('textbox', { name: 'Main' });
  const thread = screen.getByRole('textbox', { name: 'Thread' });
  drop(main, [file('same.txt'), file('same.txt')]);
  await waitFor(() => expect(state.uploadWithProgress).toHaveBeenCalledTimes(2));
  fireEvent.change(thread, { target: { value: 'Only in thread' } });
  fireEvent.paste(thread, { clipboardData: transfer([file('thread.txt')]) });
  await waitFor(() =>
    expect(screen.getByRole('group', { name: 'thread.txt' })).toHaveTextContent('success'),
  );
  await act(async () => pending[1].resolve({ id: 'second', url: '/second' }));
  pressEnter(main);
  expect(mainSend).not.toHaveBeenCalled();
  pressEnter(thread);
  await waitFor(() => expect(thread).toHaveValue(''));
  expect(threadSend.mock.calls[0]).toEqual([
    'Only in thread',
    [],
    expect.any(String),
    'normal',
    undefined,
    ['attachment'],
  ]);
  expect(screen.getAllByRole('group', { name: 'same.txt' })).toHaveLength(2);
  await act(async () => pending[0].resolve({ id: 'first', url: '/first' }));
  pressEnter(main);
  await waitFor(() => expect(mainSend).toHaveBeenCalledTimes(1));
  expect(mainSend.mock.calls[0]).toEqual([
    '',
    [],
    expect.any(String),
    'normal',
    undefined,
    ['first', 'second'],
  ]);
  expect(new Set(state.uploadWithProgress.mock.calls.map(([args]) => args.uploadId)).size).toBe(3);
});

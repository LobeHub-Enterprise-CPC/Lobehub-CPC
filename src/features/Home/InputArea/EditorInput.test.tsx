import { render } from '@testing-library/react';
import { type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const captured = vi.hoisted(() => ({ props: {} as Record<string, any> }));
const files = vi.hoisted(() => ({
  state: { chatContextSelectionsByContext: {}, chatUploadFileList: [] as unknown[] },
}));
const chat = vi.hoisted(() => ({ editor: undefined as unknown }));

vi.mock('@/features/ChatInput', () => ({
  ChatInputProvider: ({ children, ...props }: { children: ReactNode }) => {
    captured.props = props;
    return children;
  },
  DesktopChatInput: () => null,
}));
vi.mock('@/features/ChatInput/ActionBar', () => ({ default: () => null }));
vi.mock('@/features/ChatInput/ActionBar/Upload', () => ({ default: () => null }));
vi.mock('./ModeSelect', () => ({ default: () => null }));
vi.mock('@/store/chat', () => ({
  useChatStore: Object.assign(vi.fn(), {
    getState: () => ({ mainInputEditor: chat.editor }),
    setState: vi.fn(),
  }),
}));
vi.mock('@/store/file', () => ({
  useFileStore: Object.assign((selector: (state: object) => unknown) => selector(files.state), {
    getState: () => files.state,
  }),
}));
vi.mock('@/store/file/selectors', () => ({
  fileChatSelectors: {
    chatContextSelections: () => () => [],
    chatUploadFileList: (state: typeof files.state) => state.chatUploadFileList,
  },
}));

const { default: EditorInput } = await import('./EditorInput');

const base = {
  contextSelectionKey: 'home',
  initialValue: '',
  isAgentConfigLoading: false,
  loading: false,
  mode: 'agent',
  onModeChange: vi.fn(),
  onValueChange: vi.fn(),
  send: vi.fn(),
} as any;

beforeEach(() => {
  files.state.chatUploadFileList = [];
  chat.editor = undefined;
});

describe('Home EditorInput send state', () => {
  it('disables send on an empty composer', () => {
    render(<EditorInput {...base} />);

    expect(captured.props.sendButtonProps.disabled).toBe(true);
    expect(captured.props.resolveSendBlocked()).toBe(true);
  });

  it('treats whitespace as empty', () => {
    render(<EditorInput {...base} initialValue={'   '} />);

    expect(captured.props.sendButtonProps.disabled).toBe(true);
  });

  it('enables send once there is text', () => {
    render(<EditorInput {...base} initialValue={'你好'} />);

    expect(captured.props.sendButtonProps.disabled).toBe(false);
  });

  it('counts an attached file as content', () => {
    files.state.chatUploadFileList = [{ id: 'file' }];
    render(<EditorInput {...base} />);

    expect(captured.props.sendButtonProps.disabled).toBe(false);
    expect(captured.props.resolveSendBlocked()).toBe(false);
  });

  it('lets Enter through while the debounced mirror still reads empty', () => {
    chat.editor = { getMarkdownContent: () => '刚输入的内容' };
    render(<EditorInput {...base} />);

    expect(captured.props.sendButtonProps.disabled).toBe(true);
    expect(captured.props.resolveSendBlocked()).toBe(false);
  });

  it('blocks while the agent config is loading', () => {
    chat.editor = { getMarkdownContent: () => '内容' };
    render(<EditorInput {...base} isAgentConfigLoading initialValue={'内容'} />);

    expect(captured.props.resolveSendBlocked()).toBe(true);
  });
});

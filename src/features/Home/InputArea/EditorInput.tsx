import { COMPOSER_AGENT_ONLY_LAYOUT } from '@lobechat/business-const';
import { ActionIcon, Flexbox } from '@lobehub/ui';
import { PlusIcon } from 'lucide-react';
import { memo, type ReactNode, useCallback, useMemo } from 'react';

import {
  type ActionKeys,
  ChatInputProvider,
  DesktopChatInput,
  type SendButtonHandler,
} from '@/features/ChatInput';
import ActionBar from '@/features/ChatInput/ActionBar';
import FileUpload from '@/features/ChatInput/ActionBar/Upload';
import { useChatStore } from '@/store/chat';
import { useFileStore } from '@/store/file';
import { fileChatSelectors } from '@/store/file/selectors';

import type { HomeMode } from '../types';
import { HOME_INPUT_BODY_HEIGHT } from './constants';
import ModeSelect from './ModeSelect';

const leftActions: ActionKeys[] = COMPOSER_AGENT_ONLY_LAYOUT
  ? ['plus', 'approvalMode', 'deviceStatus']
  : ['plus'];
const rightActions: ActionKeys[] = COMPOSER_AGENT_ONLY_LAYOUT
  ? ['model', 'voiceDictation']
  : ['model'];

const CONTAINER_RADIUS = 20;
/** Clearance from the container edge to the round controls sitting in its corners. */
const ACTION_BAR_INSET = 8;

export interface HomeEditorInputProps {
  agentId?: string;
  contextSelectionKey: string;
  initialValue: string;
  isAgentConfigLoading: boolean;
  loading: boolean;
  mode: HomeMode;
  onModeChange: (mode: HomeMode) => void;
  onValueChange: (value: string) => void;
  placeholder?: ReactNode;
  send: SendButtonHandler;
}

const HomeEditorInput = memo<HomeEditorInputProps>(
  ({
    agentId,
    contextSelectionKey,
    initialValue,
    isAgentConfigLoading,
    loading,
    mode,
    onModeChange,
    onValueChange,
    placeholder,
    send,
  }) => {
    const inputContainerProps = useMemo(
      () => ({
        minHeight: HOME_INPUT_BODY_HEIGHT,
        resize: false,
        style: {
          borderRadius: CONTAINER_RADIUS,
          boxShadow: '0 1px 2px rgba(0,0,0,.03), 0 12px 32px rgba(0,0,0,.04)',
        },
      }),
      [],
    );

    const hasFiles = useFileStore((s) => fileChatSelectors.chatUploadFileList(s).length > 0);
    const hasContextSelections = useFileStore(
      (s) => fileChatSelectors.chatContextSelections(contextSelectionKey)(s).length > 0,
    );
    const isInputEmpty = !initialValue.trim() && !hasFiles && !hasContextSelections;
    const notReady = loading || isAgentConfigLoading;

    // `initialValue` mirrors the editor through a debounced onChange, so a fast
    // type→Enter arrives while it still reads empty. Enter and click decide on
    // the live editor instead; the button above only sets the visual state.
    const resolveSendBlocked = useCallback(() => {
      if (notReady) return true;

      const fileStore = useFileStore.getState();
      const editor = useChatStore.getState().mainInputEditor;
      const hasText = String(editor?.getMarkdownContent?.() || '').trim().length > 0;

      return (
        !hasText &&
        fileChatSelectors.chatUploadFileList(fileStore).length === 0 &&
        fileChatSelectors.chatContextSelections(contextSelectionKey)(fileStore).length === 0
      );
    }, [contextSelectionKey, notReady]);

    const actionBarStyle = useMemo(
      () => ({
        paddingBlockEnd: ACTION_BAR_INSET,
        paddingInline: ACTION_BAR_INSET,
      }),
      [],
    );

    return (
      <ChatInputProvider
        agentId={agentId}
        allowExpand={false}
        contextSelectionKey={contextSelectionKey}
        leftActions={leftActions}
        resolveSendBlocked={resolveSendBlocked}
        rightActions={rightActions}
        slashPlacement="bottom"
        chatInputEditorRef={(instance) => {
          if (!instance) return;
          useChatStore.setState({ mainInputEditor: instance });
        }}
        sendButtonProps={{
          disabled: notReady || isInputEmpty,
          generating: loading,
          onStop: () => {},
          shape: 'round',
        }}
        onMarkdownContentChange={onValueChange}
        onSend={send}
      >
        <DesktopChatInput
          actionBarStyle={actionBarStyle}
          dropdownPlacement="bottomLeft"
          initialContent={initialValue}
          inputContainerProps={inputContainerProps}
          placeholder={placeholder}
          showControlBar={false}
          leftContent={
            <Flexbox horizontal align={'center'} gap={2}>
              {!COMPOSER_AGENT_ONLY_LAYOUT && <ModeSelect value={mode} onChange={onModeChange} />}
              {isAgentConfigLoading ? (
                <ActionIcon disabled icon={PlusIcon} size={'small'} />
              ) : mode === 'task' ? (
                <FileUpload includeKnowledge={false} />
              ) : (
                <ActionBar disableCollapse dropdownPlacement="bottomLeft" />
              )}
            </Flexbox>
          }
        />
      </ChatInputProvider>
    );
  },
);

HomeEditorInput.displayName = 'HomeEditorInput';

export default HomeEditorInput;

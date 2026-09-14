import { CHANNEL_LIMITS, type ChannelMode } from '@lobechat/types';
import {
  INSERT_MENTION_COMMAND,
  ReactCodePlugin,
  ReactLinkHighlightPlugin,
  ReactListPlugin,
  ReactMentionPlugin,
} from '@lobehub/editor';
import {
  ChatInput,
  ChatInputActionBar,
  Editor,
  SendButton,
  useEditor,
} from '@lobehub/editor/react';
import { Flexbox, InputNumber, Tooltip } from '@lobehub/ui';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import WideScreenContainer from '@/features/WideScreenContainer';
import { useSingleton } from '@/hooks/useSingleton';
import { useGlobalStore } from '@/store/global';
import { systemStatusSelectors } from '@/store/global/selectors';

import { channelMentionIds } from './mentions';
import { ModeSelector } from './ModeSelector';
import { styles } from './styles';

const plugins = [ReactCodePlugin, ReactListPlugin, ReactLinkHighlightPlugin, ReactMentionPlugin];

export function Composer({
  members,
  onSend,
  replying,
  onStop,
  placeholder,
}: {
  members: { id: string; name: string }[];
  replying?: boolean;
  onStop?: () => void;
  placeholder?: string;
  onSend: (
    content: string,
    mentions: string[],
    requestKey: string,
    mode: ChannelMode,
    maxDiscussionRounds?: number,
  ) => Promise<void>;
}) {
  const { t } = useTranslation('channel');
  const editor = useEditor();
  const height = useGlobalStore(systemStatusSelectors.chatInputHeight);
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<ChannelMode>('normal');
  /** null = the server default number of rounds. */
  const [maxDiscussionRounds, setMaxDiscussionRounds] = useState<number | null>(null);
  const sending = useRef(false);
  const [error, setError] = useState('');
  const requestKey = useSingleton(() => ({ current: crypto.randomUUID() }));
  const send = async () => {
    const value = String(editor.getDocument('markdown') || '').trim();
    if (sending.current || !value) return;
    sending.current = true;
    setBusy(true);
    setError('');
    try {
      await onSend(
        value,
        channelMentionIds(
          editor.getDocument('json'),
          members.map((member) => member.id),
        ),
        requestKey.current,
        mode,
        mode === 'discussion' ? (maxDiscussionRounds ?? undefined) : undefined,
      );
      editor.cleanDocument();
      setContent('');
      requestKey.current = crypto.randomUUID();
    } catch {
      setError(t('sendFailed'));
    } finally {
      sending.current = false;
      setBusy(false);
    }
  };
  return (
    <WideScreenContainer fullWidth paddingInline={24}>
      <Flexbox className={styles.composer} gap={8}>
        <ChatInput
          resize
          defaultHeight={height || 32}
          maxHeight={320}
          minHeight={36}
          footer={
            <ChatInputActionBar
              style={{ paddingRight: 8 }}
              left={
                <Flexbox horizontal align="center" gap={8}>
                  <ModeSelector
                    value={mode}
                    onChange={(value) => {
                      setMode(value);
                      requestKey.current = crypto.randomUUID();
                    }}
                  />
                  {mode === 'discussion' && (
                    <Tooltip
                      title={t('discussionRoundsHint', {
                        defaultRounds: CHANNEL_LIMITS.discussionRounds,
                      })}
                    >
                      <Flexbox horizontal align="center" gap={4}>
                        <span>{t('discussionRoundsShort')}</span>
                        <InputNumber
                          changeOnWheel
                          aria-label={t('discussionRounds')}
                          max={CHANNEL_LIMITS.maxDiscussionRounds}
                          min={1}
                          placeholder={String(CHANNEL_LIMITS.discussionRounds)}
                          precision={0}
                          size="small"
                          style={{ width: 64 }}
                          value={maxDiscussionRounds}
                          onChange={(value) => {
                            if (
                              value === null ||
                              (typeof value === 'number' && Number.isInteger(value))
                            ) {
                              setMaxDiscussionRounds(value);
                              requestKey.current = crypto.randomUUID();
                            }
                          }}
                        />
                      </Flexbox>
                    </Tooltip>
                  )}
                </Flexbox>
              }
              right={
                <SendButton
                  aria-label={t(replying && !content.trim() ? 'stopReply' : 'send')}
                  disabled={busy || !content.trim()}
                  generating={replying && !content.trim()}
                  loading={busy}
                  onSend={() => void send()}
                  onStop={onStop}
                />
              }
            />
          }
          onSizeChange={(chatInputHeight) =>
            useGlobalStore.getState().updateSystemStatus({ chatInputHeight })
          }
        >
          <Editor
            autoFocus
            aria-label={placeholder || t('composer')}
            content=""
            editable={!busy}
            editor={editor}
            placeholder={placeholder || t('composer')}
            plugins={plugins}
            slashPlacement="top"
            type="text"
            variant="chat"
            mentionOption={{
              items: members.map((member) => ({
                key: member.id,
                label: member.name,
                metadata: { type: 'channel-member', id: member.id },
              })),
              searchKeys: ['label'],
              markdownWriter: (node) => `@${node.label}`,
              onSelect: (instance, option) =>
                instance.dispatchCommand(INSERT_MENTION_COMMAND, {
                  label: String(option.label),
                  metadata: option.metadata,
                }),
            }}
            onPressEnter={({ event }) => {
              if (!event.shiftKey && !event.isComposing) {
                void send();
                return true;
              }
            }}
            onTextChange={() => {
              setContent(String(editor.getDocument('markdown') || ''));
              requestKey.current = crypto.randomUUID();
            }}
          />
        </ChatInput>
        {error && (
          <span className={styles.error} role="alert">
            {error}
          </span>
        )}
      </Flexbox>
    </WideScreenContainer>
  );
}

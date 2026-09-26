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
import { Flexbox } from '@lobehub/ui';
import { ActionIcon, DropdownMenu } from '@lobehub/ui/base-ui';
import { AtSign } from 'lucide-react';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import WideScreenContainer from '@/features/WideScreenContainer';
import { useSingleton } from '@/hooks/useSingleton';
import { useGlobalStore } from '@/store/global';
import { systemStatusSelectors } from '@/store/global/selectors';

import { channelMentionIds } from './mentions';
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
  onSend: (content: string, mentions: string[], requestKey: string) => Promise<void>;
}) {
  const { t } = useTranslation('channel');
  const editor = useEditor();
  const height = useGlobalStore(systemStatusSelectors.chatInputHeight);
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState(false);
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
    <WideScreenContainer>
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
                <DropdownMenu
                  items={members.map((member) => ({
                    key: member.id,
                    label: member.name,
                    onClick: () => {
                      editor.focus();
                      editor.dispatchCommand(INSERT_MENTION_COMMAND, {
                        label: member.name,
                        metadata: { type: 'channel-member', id: member.id },
                      });
                    },
                  }))}
                >
                  <ActionIcon icon={AtSign} title={t('mentionHint')} />
                </DropdownMenu>
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

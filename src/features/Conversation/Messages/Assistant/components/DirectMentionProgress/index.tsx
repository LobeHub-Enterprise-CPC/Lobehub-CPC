'use client';

import { agentDisplayName } from '@lobechat/types';
import { formatDuration } from '@lobechat/utils';
import { Block, Button, Flexbox, Spin, Tag, Text } from '@lobehub/ui';
import { cssVar } from '@lobehub/ui/stylex/cssVar.stylex';
import * as stylex from '@stylexjs/stylex';
import { SquareArrowOutUpRightIcon } from 'lucide-react';
import { memo, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useChatStore } from '@/store/chat';
import { messageMapKey } from '@/store/chat/utils/messageMapKey';

import { useAgentMeta } from '../../../../hooks';
import { contextSelectors, useConversationStore } from '../../../../store';
import { summarizeThreadProgress } from './summarize';

const styles = stylex.create({
  activity: {
    color: cssVar.colorTextTertiary,
    fontSize: 13,
  },
  text: {
    color: cssVar.colorText,
  },
});

const useElapsed = (startedAt: number) => {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  return Math.max(0, now - startedAt);
};

interface DirectMentionProgressProps {
  /** The mentioned agent, which runs the thread. */
  agentId: string;
  messageId: string;
  startedAt: number;
  threadId: string;
}

/**
 * Live card for a direct @Agent reply still being written in its thread:
 * who is working, for how long, what it is doing and the newest line of its
 * answer, with the way into the full record.
 */
const DirectMentionProgress = memo<DirectMentionProgressProps>(
  ({ agentId, messageId, startedAt, threadId }) => {
    const { t } = useTranslation('chat');
    const meta = useAgentMeta(agentId);
    const topicId = useConversationStore(contextSelectors.topicId);
    const openThreadInPortal = useChatStore((s) => s.openThreadInPortal);
    const elapsed = useElapsed(startedAt);

    const threadKey = messageMapKey({ agentId, scope: 'thread', threadId, topicId });
    const messages = useChatStore((s) => s.dbMessagesMap[threadKey]);
    const { activity, text } = useMemo(() => summarizeThreadProgress(messages ?? []), [messages]);

    const activityLine =
      activity?.type === 'tool'
        ? t('directMention.progress.usingTool', { name: activity.name })
        : (activity?.text ?? t('directMention.progress.thinking'));

    return (
      <Flexbox gap={8}>
        <Flexbox horizontal align={'center'} gap={8}>
          <Spin size={'small'} />
          <Text weight={500}>
            {t('directMention.progress.running', { name: agentDisplayName(meta) })}
          </Text>
          <Tag size={'small'}>
            {t('directMention.progress.elapsed', {
              time: formatDuration(Math.floor(elapsed / 1000) * 1000),
            })}
          </Tag>
        </Flexbox>
        <Block gap={8} paddingBlock={12} paddingInline={16} variant={'filled'}>
          <Text ellipsis {...stylex.props(styles.activity)}>
            {activityLine}
          </Text>
          {text && (
            <Text ellipsis {...stylex.props(styles.text)}>
              {text}
            </Text>
          )}
        </Block>
        <Flexbox horizontal>
          <Button
            icon={SquareArrowOutUpRightIcon}
            outdent={'start'}
            size={'small'}
            type={'text'}
            onClick={() => openThreadInPortal(threadId, messageId)}
          >
            {t('directMention.progress.viewFullRecord')}
          </Button>
        </Flexbox>
      </Flexbox>
    );
  },
);

DirectMentionProgress.displayName = 'DirectMentionProgress';

export default DirectMentionProgress;

import { Flexbox } from '@lobehub/ui';
import { ActionIcon, Button } from '@lobehub/ui/base-ui';
import { CornerUpLeft, MessageSquare } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ChatItem } from '@/features/Conversation/ChatItem';
import Markdown from '@/features/Conversation/Markdown';
import { createStore, Provider } from '@/features/Conversation/store';
import WideScreenContainer from '@/features/WideScreenContainer';
import { useUserAvatar } from '@/hooks/useUserAvatar';
import { channelService } from '@/services/channel';

import { channelActivity } from './activity';
import { getApprovalContent } from './approvalContent';
import { Composer } from './Composer';
import { styles } from './styles';

type Detail = Awaited<ReturnType<typeof channelService.detail>>;

/** Each mounted conversation owns its editor, scroll position and execution scope. */
export function ChannelConversation({
  data,
  inert,
  threadId = null,
  onOpenThread,
  onRefresh,
}: {
  data: Detail;
  inert?: boolean;
  threadId?: string | null;
  onOpenThread?: (id: string) => void;
  onRefresh: () => Promise<unknown>;
}) {
  const { t } = useTranslation('channel');
  const selfAvatar = useUserAvatar();
  const channelId = data.channel.id;
  const feedRef = useRef<HTMLDivElement>(null);
  const followLatest = useRef(true);
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const activity = channelActivity(data, threadId);
  const messages = data.messages.filter((message) => message.threadId === threadId);
  const thread = data.threads.find((item) => item.id === threadId);
  const root = thread && data.messages.find((message) => message.id === thread.rootMessageId);
  useEffect(() => {
    const feed = feedRef.current;
    if (feed && followLatest.current) feed.scrollTop = feed.scrollHeight;
  }, [messages.length]);
  const action = async (fn: () => Promise<unknown>) => {
    setError('');
    try {
      await fn();
      await onRefresh();
    } catch {
      setError(t('actionFailed'));
    }
  };
  const renderMessage = (message: Detail['messages'][number]) => (
    <ChatItem
      id={message.id}
      message={<Markdown>{message.content}</Markdown>}
      placement={message.authorMemberId ? 'left' : 'right'}
      showAvatar={!!message.authorMemberId}
      showTitle={!!message.authorMemberId}
      actions={
        !threadId &&
        (!data.channel.archived ||
          data.threads.some((item) => item.rootMessageId === message.id)) && (
          <ActionIcon
            aria-label={t('openThread')}
            icon={CornerUpLeft}
            size="small"
            title={t('openThread')}
            onClick={() =>
              action(async () => {
                const reply =
                  data.threads.find((item) => item.rootMessageId === message.id) ||
                  (await channelService.branch(channelId, message.id));
                await onRefresh();
                onOpenThread?.(reply.id);
              })
            }
          />
        )
      }
      avatar={{
        avatar: message.authorMemberId
          ? data.members.find((member) => member.id === message.authorMemberId)?.config.avatar ||
            '🤖'
          : selfAvatar,
        title: message.authorMemberId
          ? data.members.find((member) => member.id === message.authorMemberId)?.name
          : t('owner'),
      }}
    />
  );
  return (
    <Flexbox className={styles.body} data-channel-conversation={threadId || 'main'} inert={inert}>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <Flexbox className={styles.approvals} gap={8}>
        {data.approvals
          .filter(
            (approval) =>
              !approval.decision &&
              data.runs.some(
                (run) =>
                  run.manifest.threadId === threadId &&
                  run.id === approval.runId &&
                  !run.publicationRevoked &&
                  !run.writerReleased,
              ),
          )
          .map((approval) => (
            <Flexbox className={styles.message} gap={8} key={approval.id}>
              <strong>
                {t('permissionRequest', {
                  name:
                    data.members.find(
                      (member) =>
                        member.id === data.runs.find((run) => run.id === approval.runId)?.memberId,
                    )?.name || 'Agent',
                })}
              </strong>
              <pre className={styles.approvalPayload}>{getApprovalContent(approval.request)}</pre>
              <Flexbox horizontal gap={8}>
                <Button
                  onClick={() =>
                    action(() => channelService.approve(channelId, approval.id, false))
                  }
                >
                  {t('reject')}
                </Button>
                <Button
                  type="primary"
                  onClick={() => action(() => channelService.approve(channelId, approval.id, true))}
                >
                  {t('approve')}
                </Button>
              </Flexbox>
            </Flexbox>
          ))}
      </Flexbox>
      <Provider
        createStore={() =>
          createStore({
            context: { agentId: `channel:${channelId}`, topicId: threadId },
            skipFetch: true,
          })
        }
      >
        <Flexbox
          aria-label={t(threadId ? 'thread' : 'main')}
          className={styles.feed}
          data-channel-feed={threadId || 'main'}
          ref={feedRef}
          onScroll={(event) => {
            const feed = event.currentTarget;
            followLatest.current = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 64;
          }}
        >
          <WideScreenContainer>
            {root && (
              <Flexbox className={styles.threadRoot}>
                {renderMessage(root)}
                <span className={styles.replyDivider}>
                  {t('replyCount', { count: messages.length })}
                </span>
              </Flexbox>
            )}
            {!messages.length && (
              <p className={styles.muted}>{t(threadId ? 'noReplies' : 'noMessages')}</p>
            )}
            {messages.map((message) => {
              const replyThread =
                !threadId && data.threads.find((item) => item.rootMessageId === message.id);
              return (
                <Flexbox data-message-id={message.id} key={message.id}>
                  {renderMessage(message)}
                  {replyThread && (
                    <Button
                      className={styles.replyLink}
                      icon={MessageSquare}
                      size="small"
                      type="text"
                      onClick={() => onOpenThread?.(replyThread.id)}
                    >
                      {t('replyCount', {
                        count: data.messages.filter((item) => item.threadId === replyThread.id)
                          .length,
                      })}
                    </Button>
                  )}
                </Flexbox>
              );
            })}
          </WideScreenContainer>
        </Flexbox>
      </Provider>
      <WideScreenContainer>
        <Flexbox
          aria-atomic="true"
          aria-live="polite"
          className={styles.activity}
          data-channel-activity={threadId || 'main'}
          role="status"
        >
          {sending
            ? t('activity.sending')
            : activity.length
              ? activity.map((item) => (
                  <span data-member-id={item.memberId} data-state={item.state} key={item.memberId}>
                    {item.name} · {t(`activity.${item.state}`)}
                  </span>
                ))
              : messages.findLast((message) => !message.authorMemberId)?.routingStatus ===
                  'unassigned'
                ? t(
                    data.members.some((member) => member.active)
                      ? 'activity.undelivered'
                      : 'activity.noMembers',
                  )
                : null}
        </Flexbox>
      </WideScreenContainer>
      {!data.channel.archived && (
        <Composer
          key={`${channelId}:${threadId || 'main'}`}
          members={data.members.filter((member) => member.active)}
          placeholder={t(threadId ? 'threadComposer' : 'composer')}
          replying={data.jobs.some(
            (job) =>
              job.threadId === (threadId || null) && ['queued', 'running'].includes(job.status),
          )}
          onSend={async (content, mentions, requestKey) => {
            followLatest.current = true;
            setSending(true);
            try {
              await channelService.send({ channelId, threadId, content, mentions, requestKey });
              await onRefresh();
            } finally {
              setSending(false);
            }
          }}
          onStop={() =>
            void action(() => channelService.stop(channelId, { threadId: threadId || null }))
          }
        />
      )}
    </Flexbox>
  );
}

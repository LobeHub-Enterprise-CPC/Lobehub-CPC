import { Empty, Flexbox } from '@lobehub/ui';
import { ActionIcon, Button } from '@lobehub/ui/base-ui';
import { GitBranch, MessageSquare } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import CollapsibleContent from '@/components/CollapsibleContent';
import { ChatItem } from '@/features/Conversation/ChatItem';
import Markdown from '@/features/Conversation/Markdown';
import { createStore, Provider } from '@/features/Conversation/store';
import ThreadDivider from '@/features/Portal/Thread/Chat/ThreadDivider';
import WideScreenContainer from '@/features/WideScreenContainer';
import { useUserAvatar } from '@/hooks/useUserAvatar';
import { channelService } from '@/services/channel';
import { useUserStore } from '@/store/user';
import { userProfileSelectors } from '@/store/user/selectors';

import { channelActivity } from './activity';
import { getApprovalContent } from './approvalContent';
import { Composer } from './Composer';
import { MessageAttachments } from './MessageAttachments';
import { MessageReceipts } from './MessageReceipts';
import type { ChannelReceipts } from './receipts';
import { styles } from './styles';
import type { ChannelPagination } from './useChannelPage';

type Detail = Awaited<ReturnType<typeof channelService.detail>>;

/** Each mounted conversation owns its editor, scroll position and execution scope. */
export function ChannelConversation({
  data,
  receipts,
  pagination,
  inert,
  threadId = null,
  onOpenThread,
  onRefresh,
}: {
  data: Detail;
  receipts: ChannelReceipts;
  pagination: ChannelPagination;
  inert?: boolean;
  threadId?: string | null;
  onOpenThread?: (id: string) => void;
  onRefresh: () => Promise<unknown>;
}) {
  const { t } = useTranslation('channel');
  const selfAvatar = useUserAvatar();
  const selfTitle = useUserStore(userProfileSelectors.displayUserName);
  const channelId = data.channel.id;
  const feedRef = useRef<HTMLDivElement>(null);
  const followLatest = useRef(true);
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const [retryingRouting, setRetryingRouting] = useState(false);
  const activity = channelActivity(data, threadId);
  const messages = data.messages.filter((message) => message.threadId === threadId);
  const lastMessageId = messages.at(-1)?.id;
  const thread = data.threads.find((item) => item.id === threadId);
  const root =
    thread && data.contextMessages.find((message) => message.id === thread.rootMessageId);
  const latestRequest = [...data.contextMessages, ...messages]
    .filter((message) => message.threadId === threadId && !message.authorMemberId)
    .sort((a, b) => b.sequence - a.sequence)[0];
  const discussion = data.discussions.find((item) => item.requestMessageId === latestRequest?.id);
  const canRetryRouting =
    latestRequest?.routingStatus === 'unassigned' &&
    !data.channel.archived &&
    (!discussion || discussion.endReason === 'routing_failed') &&
    data.members.some(
      (member) => member.active && (!thread || thread.followerMemberIds.includes(member.id)),
    );
  const discussionStatus = discussion
    ? t(`discussion.${discussion.status}`, {
        count: discussion.turnsPublished,
        max: discussion.maxRounds,
        round: discussion.round,
      })
    : null;
  const discussionReason = discussion?.endReason
    ? t(`discussion.endReason.${discussion.endReason}`, {
        defaultValue: t('discussion.endReason.other'),
      })
    : null;
  const activityNotice = sending
    ? t('activity.sending')
    : activity.length
      ? null
      : thread &&
          !data.members.some(
            (member) => member.active && thread.followerMemberIds.includes(member.id),
          )
        ? t('threadNoFollowers')
        : latestRequest?.routingStatus === 'unassigned'
          ? t(
              data.members.some((member) => member.active)
                ? 'activity.undelivered'
                : 'activity.noMembers',
            )
          : null;
  useEffect(() => {
    const feed = feedRef.current;
    if (feed && followLatest.current) feed.scrollTop = feed.scrollHeight;
  }, [lastMessageId]);
  useEffect(() => {
    const feed = feedRef.current;
    if (feed) feed.scrollTop = feed.scrollHeight;
    followLatest.current = true;
  }, [pagination.pageKey]);
  const action = async (fn: () => Promise<unknown>) => {
    setError('');
    try {
      await fn();
      await onRefresh();
    } catch {
      setError(t('actionFailed'));
    }
  };
  const renderMessage = (message: Detail['messages'][number], replyThreadId?: string) => {
    const replyCount = replyThreadId
      ? (data.replyCounts.find((item) => item.threadId === replyThreadId)?.count ?? 0)
      : 0;
    return (
      <ChatItem
        showAvatar
        showTitle
        avatarProps={{ size: 36 }}
        className={styles.channelMessage}
        gap={4}
        id={message.id}
        paddingBlock={12}
        placement="left"
        style={{ paddingInlineStart: 48 }}
        actionAddon={
          replyThreadId && replyCount > 0 ? (
            <Button
              icon={GitBranch}
              size="small"
              type="text"
              onClick={() => onOpenThread?.(replyThreadId)}
            >
              {t('replyCount', { count: replyCount })}
            </Button>
          ) : undefined
        }
        avatar={{
          avatar: message.authorMemberId
            ? data.members.find((member) => member.id === message.authorMemberId)?.config.avatar ||
              '🤖'
            : selfAvatar,
          title: message.authorMemberId
            ? data.members.find((member) => member.id === message.authorMemberId)?.name
            : selfTitle,
        }}
        belowMessage={
          !message.authorMemberId && message.threadId === threadId ? (
            <MessageReceipts
              receipts={receipts.byMessage.get(message.id) || []}
              routingStatus={message.routingStatus}
            />
          ) : undefined
        }
        customAvatarRender={(_, avatar) => (
          <Flexbox className={styles.messageAvatar}>{avatar}</Flexbox>
        )}
        message={
          <CollapsibleContent key={message.id}>
            <Flexbox gap={8}>
              {!!message.fileIds?.length && (
                <MessageAttachments
                  items={message.fileIds.map(
                    (id) =>
                      data.attachments.find((file) => file.id === id) ?? {
                        id,
                        inaccessible: true,
                        name: '',
                        fileType: '',
                        size: 0,
                        url: '',
                      },
                  )}
                />
              )}
              {message.content && <Markdown>{message.content}</Markdown>}
            </Flexbox>
          </CollapsibleContent>
        }
        titleAddon={
          !threadId &&
          replyCount === 0 &&
          (!data.channel.archived ||
            data.threads.some((item) => item.rootMessageId === message.id)) && (
            <ActionIcon
              aria-label={t('openThread')}
              className={styles.branchAction}
              icon={GitBranch}
              size="small"
              title={t('openThread')}
              onClick={() => {
                const existing = data.threads.find((item) => item.rootMessageId === message.id);
                if (existing) {
                  onOpenThread?.(existing.id);
                  return;
                }
                void action(async () => {
                  const reply = await channelService.branch(channelId, message.id);
                  await onRefresh();
                  onOpenThread?.(reply.id);
                });
              }}
            />
          )
        }
      />
    );
  };
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
          justify={!threadId && !messages.length ? 'center' : undefined}
          ref={feedRef}
          onScroll={(event) => {
            const feed = event.currentTarget;
            followLatest.current = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 64;
          }}
        >
          <WideScreenContainer fullWidth paddingInline={24}>
            {(pagination.hasOlder || pagination.hasNewer) && (
              <Flexbox horizontal align="center" gap={8} justify="center" paddingBlock={8}>
                <Button
                  disabled={!pagination.hasOlder || pagination.isLoading}
                  size="small"
                  onClick={pagination.older}
                >
                  {t('history.older')}
                </Button>
                <Button
                  disabled={!pagination.hasNewer || pagination.isLoading}
                  size="small"
                  onClick={pagination.newer}
                >
                  {t('history.newer')}
                </Button>
                {pagination.hasNewer && (
                  <Button
                    disabled={pagination.isLoading}
                    size="small"
                    type="text"
                    onClick={pagination.latest}
                  >
                    {t('history.latest')}
                  </Button>
                )}
              </Flexbox>
            )}
            {root && (
              <Flexbox className={styles.threadRoot}>
                {renderMessage(root)}
                {messages.length > 0 && (
                  <ThreadDivider>
                    {t('replyCount', {
                      count:
                        data.replyCounts.find((item) => item.threadId === threadId)?.count ?? 0,
                    })}
                  </ThreadDivider>
                )}
              </Flexbox>
            )}
            {!messages.length &&
              (threadId ? (
                <p className={styles.muted}>{t('noReplies')}</p>
              ) : (
                <Empty
                  description={t('noMessages')}
                  icon={MessageSquare}
                  title={t('noMessagesTitle')}
                />
              ))}
            {messages.map((message) => {
              const replyThread =
                !threadId && data.threads.find((item) => item.rootMessageId === message.id);
              return (
                <Flexbox data-message-id={message.id} key={message.id}>
                  {renderMessage(message, replyThread ? replyThread.id : undefined)}
                </Flexbox>
              );
            })}
          </WideScreenContainer>
        </Flexbox>
      </Provider>
      {(discussionStatus || activityNotice) && (
        <WideScreenContainer fullWidth paddingInline={24}>
          <Flexbox
            aria-atomic="true"
            aria-live="polite"
            className={styles.activity}
            data-channel-activity={threadId || 'main'}
            role="status"
          >
            {discussionStatus && (
              <span data-discussion-status={discussion?.status}>
                {discussionStatus}
                {discussionReason ? ` · ${discussionReason}` : ''}
              </span>
            )}
            {activityNotice && <span>{activityNotice}</span>}
            {canRetryRouting && (
              <Button
                disabled={retryingRouting}
                size="small"
                type="text"
                onClick={() => {
                  setRetryingRouting(true);
                  void action(() =>
                    channelService.retryRouting(channelId, latestRequest!.id),
                  ).finally(() => setRetryingRouting(false));
                }}
              >
                {t('retryRouting')}
              </Button>
            )}
          </Flexbox>
        </WideScreenContainer>
      )}
      {!data.channel.archived && (
        <Composer
          key={`${channelId}:${threadId || 'main'}`}
          members={data.members.filter((member) => member.active)}
          placeholder={t(threadId ? 'threadComposer' : 'composer')}
          replying={
            latestRequest?.routingStatus === 'pending' ||
            data.jobs.some(
              (job) =>
                job.threadId === (threadId || null) && ['queued', 'running'].includes(job.status),
            )
          }
          onSend={async (content, mentions, requestKey, mode, maxDiscussionRounds, fileIds) => {
            followLatest.current = true;
            setSending(true);
            try {
              await channelService.send({
                channelId,
                content,
                fileIds,
                mode,
                maxDiscussionRounds,
                mentions,
                requestKey,
                threadId,
              });
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

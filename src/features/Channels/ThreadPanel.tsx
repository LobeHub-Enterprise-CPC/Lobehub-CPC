import { Flexbox, Icon } from '@lobehub/ui';
import { ActionIcon, Button, Text } from '@lobehub/ui/base-ui';
import { cssVar } from 'antd-style';
import { GitBranch, X } from 'lucide-react';
import { Activity, useState } from 'react';
import { useTranslation } from 'react-i18next';

import NavHeader from '@/features/NavHeader';
import RightPanel from '@/features/RightPanel';
import type { channelService } from '@/services/channel';

import { ChannelConversation } from './ChannelConversation';
import { buildChannelReceipts } from './receipts';
import { styles } from './styles';
import { ThreadFollowers } from './ThreadFollowers';
import { useChannelPage } from './useChannelPage';

function ThreadConversation({
  channelId,
  threadId,
  onRefresh,
}: {
  channelId: string;
  threadId: string;
  onRefresh: () => Promise<unknown>;
}) {
  const { t } = useTranslation('channel');
  const { data, error, mutate, pagination } = useChannelPage(channelId, threadId);
  if (!data)
    return (
      <Flexbox padding={16} role={error ? 'alert' : 'status'}>
        {t(error ? 'refreshFailed' : 'loading')}
        {error && <Button onClick={() => mutate()}>{t('reload')}</Button>}
      </Flexbox>
    );
  return (
    <>
      {error && (
        <Flexbox padding={16} role="alert">
          {t('refreshFailed')}
          <Button onClick={() => mutate()}>{t('reload')}</Button>
        </Flexbox>
      )}
      <ChannelConversation
        data={data}
        pagination={pagination}
        receipts={buildChannelReceipts(data)}
        threadId={threadId}
        onRefresh={() => Promise.all([mutate(), onRefresh()])}
      />
    </>
  );
}

export function ThreadPanel({
  availableWidth = 1000,
  data,
  threadId,
  onClose,
  onRefresh,
}: {
  availableWidth?: number;
  data: Awaited<ReturnType<typeof channelService.detail>>;
  threadId: string | null;
  onClose: () => void;
  onRefresh: () => Promise<unknown>;
}) {
  const { t } = useTranslation('channel');
  const [lastThreadId, setLastThreadId] = useState(threadId);
  const [preferredWidth, setPreferredWidth] = useState(520);
  if (threadId && threadId !== lastThreadId) setLastThreadId(threadId);
  const narrow = availableWidth < 760;
  const maxWidth = narrow ? availableWidth : availableWidth - 360;
  const width = Math.min(preferredWidth, maxWidth);
  const thread = data.threads.find((item) => item.id === lastThreadId);

  return (
    <RightPanel
      className={styles.threadPanel}
      classNames={{ content: styles.threadContent }}
      expand={!!threadId}
      maxWidth={maxWidth}
      minWidth={Math.min(360, maxWidth)}
      mode={narrow ? 'float' : 'fixed'}
      showHandleWhenCollapsed={false}
      showHandleWideArea={false}
      width={narrow ? availableWidth : width}
      onExpandChange={(expand) => {
        if (!expand) onClose();
      }}
      onSizeChange={(size) => {
        const next = Number.parseFloat(String(size?.width));
        if (Number.isFinite(next)) setPreferredWidth(next);
      }}
    >
      <Activity mode={threadId ? 'visible' : 'hidden'}>
        <Flexbox aria-label={t('thread')} className={styles.body} role="region">
          <NavHeader
            paddingBlock={6}
            paddingInline={8}
            showTogglePanelButton={false}
            style={{ borderBottom: `1px solid ${cssVar.colorBorderSecondary}` }}
            left={
              <Flexbox horizontal align="center" gap={8} style={{ marginInlineStart: 4 }}>
                <Icon icon={GitBranch} size={18} />
                <Text ellipsis fontSize={14}>
                  {t('thread')}
                </Text>
              </Flexbox>
            }
            right={
              <Flexbox horizontal align="center" gap={4}>
                {thread && (
                  <ThreadFollowers
                    data={data}
                    key={thread.id}
                    thread={thread}
                    onRefresh={onRefresh}
                  />
                )}
                <ActionIcon
                  aria-label={t('closeThread')}
                  icon={X}
                  size="small"
                  title={t('closeThread')}
                  onClick={onClose}
                />
              </Flexbox>
            }
          />
          {thread ? (
            <ThreadConversation
              channelId={data.channel.id}
              key={lastThreadId}
              threadId={thread.id}
              onRefresh={onRefresh}
            />
          ) : (
            <Flexbox padding={16} role="status">
              {t('threadUnavailable')}
            </Flexbox>
          )}
        </Flexbox>
      </Activity>
    </RightPanel>
  );
}

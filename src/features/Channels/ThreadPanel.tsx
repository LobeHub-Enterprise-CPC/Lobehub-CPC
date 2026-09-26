import { Flexbox } from '@lobehub/ui';
import { ActionIcon } from '@lobehub/ui/base-ui';
import { X } from 'lucide-react';
import { Activity, useState } from 'react';
import { useTranslation } from 'react-i18next';

import RightPanel from '@/features/RightPanel';
import type { channelService } from '@/services/channel';

import { ChannelConversation } from './ChannelConversation';
import { styles } from './styles';

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
  const exists = data.threads.some((item) => item.id === lastThreadId);

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
          <Flexbox
            horizontal
            align="center"
            className={styles.threadHeader}
            justify="space-between"
          >
            <strong>{t('thread')}</strong>
            <ActionIcon
              aria-label={t('closeThread')}
              icon={X}
              title={t('closeThread')}
              onClick={onClose}
            />
          </Flexbox>
          {exists ? (
            <ChannelConversation
              data={data}
              key={lastThreadId}
              threadId={lastThreadId}
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

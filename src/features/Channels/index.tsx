import { Flexbox } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { useSize } from 'ahooks';
import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate, useParams, useSearchParams } from 'react-router';
import useSWR from 'swr';

import { channelService } from '@/services/channel';
import { useUserStore } from '@/store/user';
import { labPreferSelectors } from '@/store/user/selectors';

import { ChannelConversation } from './ChannelConversation';
import { ChannelHeader } from './ChannelHeader';
import { buildChannelReceipts } from './receipts';
import { styles } from './styles';
import { ThreadPanel } from './ThreadPanel';
import { useChannelPage } from './useChannelPage';

export default function Channels() {
  const { t } = useTranslation('channel');
  const enableChannel = useUserStore(labPreferSelectors.enableChannel);
  const { channelId } = useParams<{ channelId: string }>();
  const [params, setParams] = useSearchParams();
  const threadId = params.get('thread');
  const conversationRef = useRef<HTMLDivElement>(null);
  const conversationSize = useSize(conversationRef);
  const {
    data: availability,
    error: availabilityError,
    mutate: refreshAvailability,
  } = useSWR(enableChannel ? 'channel-availability' : null, channelService.availability);
  const {
    data,
    error: detailError,
    mutate,
    pagination,
  } = useChannelPage(channelId, null, enableChannel && !!availability?.enabled);
  const loadError = availabilityError || detailError;
  const retryLoad = () => Promise.allSettled([refreshAvailability(), mutate()]);
  // Old collection links return to the home sidebar; Channels no longer have a separate list page.
  if (!channelId) return <Navigate replace to="/" />;
  if (!enableChannel) return <Flexbox padding={24}>{t('unavailable')}</Flexbox>;
  if (loadError && !data)
    return (
      <Flexbox padding={24} role="alert">
        {t('refreshFailed')}
        <Button onClick={retryLoad}>{t('reload')}</Button>
      </Flexbox>
    );
  if (!availability || (availability.enabled && !data))
    return <Flexbox padding={24}>{t('loading')}</Flexbox>;
  if (!availability.enabled) return <Flexbox padding={24}>{t('unavailable')}</Flexbox>;
  if (!data) return null;
  const receipts = buildChannelReceipts(data);
  return (
    <Flexbox className={styles.layout}>
      <ChannelHeader data={data} receipts={receipts} onRefresh={mutate} />
      {loadError && (
        <p className={styles.error} role="alert">
          {t('refreshFailed')}
          <Button size="small" onClick={retryLoad}>
            {t('reload')}
          </Button>
        </p>
      )}
      <Flexbox horizontal className={styles.conversations} ref={conversationRef}>
        <ChannelConversation
          data={data}
          inert={!!threadId && (conversationSize?.width || 1000) < 760}
          key={channelId}
          pagination={pagination}
          receipts={receipts}
          onRefresh={mutate}
          onOpenThread={(id) =>
            setParams((current) => {
              const next = new URLSearchParams(current);
              if (current.get('thread') === id) next.delete('thread');
              else next.set('thread', id);
              return next;
            })
          }
        />
        <ThreadPanel
          availableWidth={conversationSize?.width}
          data={data}
          key={`thread:${channelId}`}
          threadId={threadId}
          onClose={() => setParams({})}
          onRefresh={mutate}
        />
      </Flexbox>
    </Flexbox>
  );
}

import { Flexbox } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { useSize } from 'ahooks';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import useSWR from 'swr';

import NavHeader from '@/features/NavHeader';
import WideScreenButton from '@/features/WideScreenContainer/WideScreenButton';
import { channelService } from '@/services/channel';

import { ChannelConversation } from './ChannelConversation';
import { CreateChannel } from './CreateChannel';
import { Sidebar } from './Sidebar';
import { styles } from './styles';
import { ThreadPanel } from './ThreadPanel';

export default function Channels() {
  const { t } = useTranslation('channel');
  const { channelId } = useParams<{ channelId: string }>();
  const [params, setParams] = useSearchParams();
  const threadId = params.get('thread');
  const navigate = useNavigate();
  const conversationRef = useRef<HTMLDivElement>(null);
  const conversationSize = useSize(conversationRef);
  const [creating, setCreating] = useState(false);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState('');
  const {
    data: availability,
    error: availabilityError,
    mutate: refreshAvailability,
  } = useSWR('channel-availability', channelService.availability);
  const {
    data: list,
    error: listError,
    mutate: refreshList,
  } = useSWR(availability?.enabled ? 'channels' : null, channelService.list);
  const {
    data,
    error: detailError,
    mutate,
  } = useSWR(
    availability?.enabled && channelId ? ['channel', channelId] : null,
    () => channelService.detail(channelId!),
    { refreshInterval: 2000 },
  );
  useEffect(() => {
    if (!availability?.enabled || !channelId) return;
    const subscription = channelService.watch(channelId, (detail) => {
      void mutate(detail, { revalidate: false });
    });
    return () => subscription.unsubscribe();
  }, [availability?.enabled, channelId, mutate]);
  const action = async (fn: () => Promise<unknown>) => {
    setError('');
    try {
      await fn();
      await mutate();
    } catch {
      setError(t('actionFailed'));
    }
  };
  const loadError = availabilityError || listError || detailError;
  const retryLoad = () => Promise.allSettled([refreshAvailability(), refreshList(), mutate()]);
  if (loadError && !data)
    return (
      <Flexbox padding={24} role="alert">
        {t('refreshFailed')}
        <Button onClick={retryLoad}>{t('reload')}</Button>
      </Flexbox>
    );
  if (!availability) return <Flexbox padding={24}>{t('loading')}</Flexbox>;
  if (!availability.enabled) return <Flexbox padding={24}>{t('unavailable')}</Flexbox>;
  return (
    <Flexbox horizontal className={styles.layout}>
      <Sidebar
        channelId={channelId}
        data={data}
        list={list}
        threadId={threadId}
        onRemove={(id) => void action(() => channelService.removeMember(channelId!, id))}
        onAdd={() => {
          setCreating(false);
          setAdding(true);
        }}
        onArchive={(id) =>
          void action(async () => {
            await channelService.archive(id);
            await refreshList();
          })
        }
        onCreate={() => {
          setAdding(false);
          setCreating(true);
        }}
        onSelect={(id) => {
          setCreating(false);
          setAdding(false);
          navigate(`/channels/${id}`);
        }}
        onThread={(id) => {
          setCreating(false);
          setAdding(false);
          setParams(id ? { thread: id } : {});
        }}
      />
      <Flexbox className={styles.body}>
        {creating || (adding && data) ? (
          <CreateChannel
            existing={
              adding && data
                ? {
                    id: data.channel.id,
                    capacity: 4 - data.members.filter((m) => m.active).length,
                    agentIds: data.members
                      .filter((m) => m.active)
                      .flatMap((m) => (m.config.agentId ? [m.config.agentId] : [])),
                    ...data.members.find((m) => m.active && m.config.deviceId)?.config,
                  }
                : undefined
            }
            onCancel={() => {
              setCreating(false);
              setAdding(false);
            }}
            onCreated={(id) => {
              setCreating(false);
              setAdding(false);
              void mutate();
              void refreshList();
              navigate(`/channels/${id}`);
            }}
          />
        ) : !channelId ? (
          <Flexbox gap={16} padding={48}>
            <h2>{t('empty')}</h2>
            <p>{t('description')}</p>
          </Flexbox>
        ) : !data ? (
          <Flexbox padding={24}>{t('loading')}</Flexbox>
        ) : (
          <>
            <NavHeader right={<WideScreenButton />} />
            {(error || loadError) && (
              <p className={styles.error} role="alert">
                {error || t('refreshFailed')}
                {loadError && (
                  <Button size="small" onClick={retryLoad}>
                    {t('reload')}
                  </Button>
                )}
              </p>
            )}
            <Flexbox horizontal className={styles.conversations} ref={conversationRef}>
              <ChannelConversation
                data={data}
                inert={!!threadId && (conversationSize?.width || 1000) < 760}
                key={channelId}
                onOpenThread={(id) => setParams({ thread: id })}
                onRefresh={mutate}
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
          </>
        )}
      </Flexbox>
    </Flexbox>
  );
}

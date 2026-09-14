import { Accordion, AccordionItem, copyToClipboard, Flexbox, ScrollShadow } from '@lobehub/ui';
import { ActionIcon, Button, confirmModal, DropdownMenu, Text, toast } from '@lobehub/ui/base-ui';
import { Copy, Hash, MoreHorizontal, Plus, Trash } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import useSWR, { useSWRConfig } from 'swr';

import { useActiveWorkspaceId } from '@/business/client/hooks/useActiveWorkspaceId';
import NavItem from '@/features/NavPanel/components/NavItem';
import SkeletonList from '@/features/NavPanel/components/SkeletonList';
import ThreadNavItem from '@/features/NavPanel/components/ThreadNavItem';
import { useWorkspaceAwareNavigate } from '@/features/Workspace/useWorkspaceAwareNavigate';
import { useActiveLocation } from '@/hooks/useActiveLocation';
import { useScrollActiveThreadIntoView } from '@/hooks/useScrollActiveThreadIntoView';
import { channelService } from '@/services/channel';
import { useUserStore } from '@/store/user';
import { labPreferSelectors } from '@/store/user/selectors';

import { openCreateChannelModal } from './CreateChannel';

function ChannelThreads({
  channelId,
  threads,
}: {
  channelId: string;
  threads: Awaited<ReturnType<typeof channelService.list>>[number]['threads'];
}) {
  const { t } = useTranslation('channel');
  const { pathname, search } = useActiveLocation();
  const navigate = useWorkspaceAwareNavigate();
  const activeThreadId =
    pathname === `/channels/${channelId}` ? new URLSearchParams(search).get('thread') : null;
  const containerRef = useScrollActiveThreadIntoView(activeThreadId, threads.length);
  if (!threads.length) return null;

  return (
    <ScrollShadow
      aria-label={t('thread')}
      gap={1}
      paddingBlock={1}
      ref={containerRef}
      size={12}
      style={{ maxHeight: 9 * 37 }}
    >
      {threads.map((thread, index) => {
        const title = thread.title || `${t('thread')} ${index + 1}`;
        const href = `/channels/${channelId}?thread=${encodeURIComponent(thread.id)}`;
        return (
          <ThreadNavItem
            nested
            active={thread.id === activeThreadId}
            aria-current={thread.id === activeThreadId ? 'page' : undefined}
            data-thread-id={thread.id}
            href={href}
            key={thread.id}
            title={title}
            onClick={() => navigate(href, { escape: true })}
          />
        );
      })}
    </ScrollShadow>
  );
}

/** Channels stay beside Agents in the home sidebar, including during a Channel conversation. */
export default function ChannelList() {
  const { t } = useTranslation('channel');
  const { t: commonT } = useTranslation('common');
  const workspaceId = useActiveWorkspaceId();
  const enableChannel = useUserStore(labPreferSelectors.enableChannel);
  const { pathname, search } = useActiveLocation();
  const navigate = useWorkspaceAwareNavigate();
  const { mutate: refresh } = useSWRConfig();
  const { data: availability } = useSWR(
    !workspaceId && enableChannel ? 'channel-availability' : null,
    channelService.availability,
  );
  const {
    data: channels,
    error,
    mutate,
  } = useSWR(
    !workspaceId && enableChannel && availability?.enabled ? 'channels' : null,
    channelService.list,
  );
  if (workspaceId || !enableChannel || !availability?.enabled) return null;

  const copyId = async (id: string) => {
    try {
      await copyToClipboard(id);
      toast.success(t('copyIdSuccess'));
    } catch {
      toast.error(t('actionFailed'));
    }
  };

  const remove = (id: string, title: string) => {
    confirmModal({
      title: t('delete'),
      content: t('deleteConfirm', { title }),
      cancelText: t('cancel'),
      okText: t('delete'),
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await channelService.remove(id);
        } catch (error) {
          toast.error(t('actionFailed'));
          throw error;
        }
        if (pathname === `/channels/${id}`) navigate('/', { escape: true });
        await mutate((items) => items?.filter((item) => item.id !== id), { revalidate: false });
        void refresh(
          (key) =>
            Array.isArray(key) && ['channel', 'channel-page'].includes(key[0]) && key[1] === id,
          undefined,
          { revalidate: false },
        );
        void mutate();
      },
    });
  };

  return (
    <Accordion defaultExpandedKeys={['channels']}>
      <AccordionItem
        itemKey="channels"
        paddingBlock={4}
        paddingInline="8px 4px"
        action={
          <ActionIcon
            aria-label={t('create')}
            icon={Plus}
            size="small"
            title={t('create')}
            onClick={(event) => {
              event.stopPropagation();
              openCreateChannelModal({
                onCreated: (id) => navigate(`/channels/${id}`, { escape: true }),
              });
            }}
          />
        }
        title={
          <Text ellipsis fontSize={12} type="secondary" weight={500}>
            {t('title')}
          </Text>
        }
      >
        <Flexbox gap={1} paddingBlock={1}>
          {!channels && !error && <SkeletonList rows={2} />}
          {error && (
            <Button size="small" onClick={() => mutate()}>
              {t('reload')}
            </Button>
          )}
          {channels?.map((channel) => (
            <Flexbox key={channel.id}>
              <NavItem
                data-channel-id={channel.id}
                href={`/channels/${channel.id}`}
                icon={Hash}
                title={channel.title}
                actions={
                  <DropdownMenu
                    items={[
                      {
                        key: 'copyId',
                        label: t('copyId'),
                        icon: Copy,
                        onClick: () => copyId(channel.id),
                      },
                      { type: 'divider' },
                      {
                        key: 'delete',
                        label: t('delete'),
                        icon: Trash,
                        danger: true,
                        onClick: () => remove(channel.id, channel.title),
                      },
                    ]}
                  >
                    <ActionIcon icon={MoreHorizontal} size="small" title={commonT('more')} />
                  </DropdownMenu>
                }
                active={
                  pathname === `/channels/${channel.id}` &&
                  !new URLSearchParams(search).get('thread')
                }
                onClick={() => navigate(`/channels/${channel.id}`, { escape: true })}
              />
              <ChannelThreads channelId={channel.id} threads={channel.threads} />
            </Flexbox>
          ))}
        </Flexbox>
      </AccordionItem>
    </Accordion>
  );
}

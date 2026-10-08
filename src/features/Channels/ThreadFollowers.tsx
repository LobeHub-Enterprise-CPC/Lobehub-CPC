import { Flexbox } from '@lobehub/ui';
import { ActionIcon, Avatar, Button, Popover, Text, toast } from '@lobehub/ui/base-ui';
import { Users, X } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { channelService } from '@/services/channel';

type Detail = Awaited<ReturnType<typeof channelService.detail>>;

export function ThreadFollowers({
  data,
  thread,
  onRefresh,
}: {
  data: Detail;
  thread: Detail['threads'][number];
  onRefresh: () => Promise<unknown>;
}) {
  const { t } = useTranslation('channel');
  const [removing, setRemoving] = useState<string | null>(null);
  const followers = data.members.filter(
    (member) => member.active && thread.followerMemberIds.includes(member.id),
  );
  return (
    <Popover
      placement="bottomRight"
      trigger="click"
      content={
        <Flexbox gap={12} style={{ maxWidth: 'calc(100vw - 48px)', width: 280 }}>
          <Text weight={600}>{t('threadFollowers')}</Text>
          {followers.map((member) => (
            <Flexbox horizontal align="center" gap={8} key={member.id}>
              <Avatar avatar={member.config.avatar || '🤖'} size={28} title={member.name} />
              <Text ellipsis style={{ flex: 1, minWidth: 0 }}>
                {member.name}
              </Text>
              {!data.channel.archived && (
                <ActionIcon
                  aria-label={t('removeThreadFollower', { name: member.name })}
                  disabled={!!removing}
                  icon={X}
                  loading={removing === member.id}
                  size="small"
                  title={t('removeThreadFollower', { name: member.name })}
                  onClick={async () => {
                    setRemoving(member.id);
                    try {
                      await channelService.removeThreadFollower(
                        data.channel.id,
                        thread.id,
                        member.id,
                      );
                      await onRefresh();
                    } catch {
                      toast.error(t('actionFailed'));
                    } finally {
                      setRemoving(null);
                    }
                  }}
                />
              )}
            </Flexbox>
          ))}
          <Text fontSize={12} type="secondary">
            {t(followers.length ? 'threadFollowersHint' : 'threadNoFollowers')}
          </Text>
        </Flexbox>
      }
    >
      <Button
        aria-label={t('threadFollowerCount', { count: followers.length })}
        size="small"
        type="text"
      >
        {followers.length ? (
          <Flexbox horizontal align="center" gap={4}>
            {followers.slice(0, 3).map((member) => (
              <Avatar
                avatar={member.config.avatar || '🤖'}
                key={member.id}
                size={20}
                title={member.name}
              />
            ))}
          </Flexbox>
        ) : (
          <Users size={16} />
        )}
        {followers.length}
      </Button>
    </Popover>
  );
}

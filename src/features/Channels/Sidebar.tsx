import { Accordion, AccordionItem, Flexbox } from '@lobehub/ui';
import { ActionIcon, Avatar, DropdownMenu, Text } from '@lobehub/ui/base-ui';
import { cssVar } from 'antd-style';
import {
  Archive,
  CornerDownRight,
  HashIcon,
  MessageSquarePlus,
  MoreHorizontal,
  UserMinus,
  UserPlus,
} from 'lucide-react';
import { Fragment } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import NavItem from '@/features/NavPanel/components/NavItem';
import { NavPanelPortal } from '@/features/NavPanel/NavPanelPortal';
import SideBarHeaderLayout from '@/features/NavPanel/SideBarHeaderLayout';
import SideBarLayout from '@/features/NavPanel/SideBarLayout';
import type { channelService } from '@/services/channel';

type Detail = Awaited<ReturnType<typeof channelService.detail>>;

export function Sidebar({
  channelId,
  data,
  list,
  threadId,
  onCreate,
  onSelect,
  onThread,
  onAdd,
  onRemove,
  onArchive,
}: {
  channelId?: string;
  data?: Detail;
  list?: Awaited<ReturnType<typeof channelService.list>>;
  threadId: string | null;
  onCreate: () => void;
  onSelect: (id: string) => void;
  onThread: (id: string | null) => void;
  onAdd: () => void;
  onRemove: (id: string) => void;
  onArchive: (id: string) => void;
}) {
  const { t } = useTranslation('channel');
  const navigate = useNavigate();
  const { t: chatT } = useTranslation('chat');
  const { t: commonT } = useTranslation('common');
  const members = data?.members.filter((member) => member.active) || [];
  return (
    <NavPanelPortal navKey="channels">
      <SideBarLayout
        body={
          <Flexbox paddingInline={4}>
            <Accordion defaultExpandedKeys={['members', 'channels']} gap={8}>
              {data && (
                <AccordionItem
                  itemKey="members"
                  paddingBlock={4}
                  paddingInline="8px 4px"
                  action={
                    !data.channel.archived && (
                      <ActionIcon
                        disabled={members.length >= 4}
                        icon={UserPlus}
                        size="small"
                        title={t('addMembers')}
                        onClick={(event) => {
                          event.stopPropagation();
                          onAdd();
                        }}
                      />
                    )
                  }
                  title={
                    <Text ellipsis fontSize={12} type="secondary" weight={500}>
                      {chatT('groupSidebar.tabs.members')} {members.length}
                    </Text>
                  }
                >
                  <Flexbox gap={1} paddingBlock={1}>
                    {members.map((member) => (
                      <NavItem
                        icon={<Avatar avatar={member.config.avatar || '🤖'} size={24} />}
                        key={member.id}
                        title={member.name}
                        actions={
                          !data.channel.archived && (
                            <DropdownMenu
                              items={[
                                {
                                  key: 'remove',
                                  label: t('removeMember'),
                                  icon: UserMinus,
                                  onClick: () => onRemove(member.id),
                                },
                              ]}
                            >
                              <ActionIcon
                                icon={MoreHorizontal}
                                size="small"
                                title={commonT('more')}
                              />
                            </DropdownMenu>
                          )
                        }
                        onClick={() =>
                          member.config.agentId && navigate(`/agent/${member.config.agentId}`)
                        }
                      />
                    ))}
                  </Flexbox>
                </AccordionItem>
              )}
              <AccordionItem
                itemKey="channels"
                paddingBlock={4}
                paddingInline="8px 4px"
                title={
                  <Text ellipsis fontSize={12} type="secondary" weight={500}>
                    {t('title')} {list?.length || ''}
                  </Text>
                }
              >
                <Flexbox gap={1} paddingBlock={1}>
                  {list?.map((channel) => (
                    <Fragment key={channel.id}>
                      <NavItem
                        active={channel.id === channelId && !threadId}
                        data-channel-id={channel.id}
                        href={`/channels/${channel.id}`}
                        icon={channel.archived ? Archive : HashIcon}
                        title={channel.title}
                        titleColor={cssVar.colorText}
                        actions={
                          !channel.archived && (
                            <DropdownMenu
                              items={[
                                {
                                  key: 'archive',
                                  label: t('archive'),
                                  icon: Archive,
                                  onClick: () => onArchive(channel.id),
                                },
                              ]}
                            >
                              <ActionIcon
                                icon={MoreHorizontal}
                                size="small"
                                title={commonT('more')}
                              />
                            </DropdownMenu>
                          )
                        }
                        onClick={() => onSelect(channel.id)}
                      />
                      {channel.id === channelId &&
                        data?.threads.map((thread, index) => (
                          <NavItem
                            active={threadId === thread.id}
                            data-thread-id={thread.id}
                            icon={CornerDownRight}
                            key={thread.id}
                            style={{ minHeight: 36, paddingInlineStart: 32 }}
                            title={`${t('thread')} ${index + 1}`}
                            onClick={() => onThread(thread.id)}
                          />
                        ))}
                    </Fragment>
                  ))}
                </Flexbox>
              </AccordionItem>
            </Accordion>
          </Flexbox>
        }
        header={
          <>
            <SideBarHeaderLayout left={data?.channel.title || t('title')} />
            <Flexbox gap={1} paddingInline={4}>
              <NavItem icon={MessageSquarePlus} title={t('create')} onClick={onCreate} />
            </Flexbox>
          </>
        }
      />
    </NavPanelPortal>
  );
}

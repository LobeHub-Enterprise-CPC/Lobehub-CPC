import { CHANNEL_LIMITS } from '@lobechat/types';
import { Flexbox } from '@lobehub/ui';
import { ActionIcon, Button, Popover, toast } from '@lobehub/ui/base-ui';
import { ExternalLink, Plus, Settings2, UserMinus } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import Avatar from '@/components/Avatar';
import { channelService } from '@/services/channel';

import { openCreateChannelModal } from './CreateChannel';
import { openMemberEnvironmentModal } from './MemberEnvironmentModal';
import { ReceiptStatus, receiptTone } from './MessageReceipts';
import type { ChannelDetail, ChannelReceipts } from './receipts';
import { memberCurrentReceipt } from './receipts';
import { statusStyles as styles } from './statusStyles';

export function MemberStatus({
  data,
  receipts,
  onRefresh,
}: {
  data: ChannelDetail;
  receipts: ChannelReceipts;
  onRefresh: () => Promise<unknown>;
}) {
  const { t } = useTranslation('channel');
  const navigate = useNavigate();
  const [openMemberId, setOpenMemberId] = useState<string>();
  const [removingId, setRemovingId] = useState<string>();
  const members = data.members.filter((member) => member.active);
  const addMembers = () => {
    setOpenMemberId(undefined);
    openCreateChannelModal({
      existing: {
        id: data.channel.id,
        capacity: CHANNEL_LIMITS.members - members.length,
        agentIds: members.flatMap((member) =>
          member.config.agentId ? [member.config.agentId] : [],
        ),
      },
    });
  };
  const remove = async (id: string) => {
    if (removingId) return;
    setRemovingId(id);
    try {
      await channelService.removeMember(data.channel.id, id);
      setOpenMemberId(undefined);
      await onRefresh();
    } catch {
      toast.error(t('actionFailed'));
    } finally {
      setRemovingId(undefined);
    }
  };
  return (
    <Flexbox horizontal align="center" aria-label={t('receipt.members')} className={styles.members}>
      {members.map((member) => {
        const current = memberCurrentReceipt(receipts.byMember.get(member.id) || []);
        const state = current?.state || (member.executionPaused ? 'paused' : 'idle');
        return (
          <Popover
            classNames={{ trigger: styles.memberButton }}
            key={member.id}
            open={openMemberId === member.id}
            placement="bottomRight"
            trigger="click"
            content={
              <Flexbox className={styles.popover} gap={12}>
                <Flexbox horizontal align="center" gap={8}>
                  <Avatar avatar={member.config.avatar || '🤖'} size={28} title={member.name} />
                  <strong>{member.name}</strong>
                </Flexbox>
                <ReceiptStatus state={state} />
                <span className={styles.muted}>{t(`receipt.hint.${state}`)}</span>
                {current && (
                  <Flexbox gap={4}>
                    <span className={styles.muted}>
                      {t(current.request.threadId ? 'receipt.inThread' : 'receipt.inMain')}
                    </span>
                    <span>
                      {current.request.content.slice(0, 160)}
                      {current.request.content.length > 160 ? '…' : ''}
                    </span>
                  </Flexbox>
                )}
                <Flexbox gap={4}>
                  {member.config.agentId && (
                    <>
                      <Button
                        icon={ExternalLink}
                        size="small"
                        type="text"
                        onClick={() => {
                          setOpenMemberId(undefined);
                          navigate(`/agent/${member.config.agentId}`);
                        }}
                      >
                        {t('openAgent')}
                      </Button>
                      <Button
                        icon={Settings2}
                        size="small"
                        type="text"
                        onClick={() => {
                          setOpenMemberId(undefined);
                          openMemberEnvironmentModal({
                            channelId: data.channel.id,
                            memberId: member.id,
                          });
                        }}
                      >
                        {t('environment.manage')}
                      </Button>
                    </>
                  )}
                  {!data.channel.archived && (
                    <Button
                      danger
                      disabled={!!removingId}
                      icon={UserMinus}
                      loading={removingId === member.id}
                      size="small"
                      type="text"
                      onClick={() => remove(member.id)}
                    >
                      {t('removeMember')}
                    </Button>
                  )}
                </Flexbox>
              </Flexbox>
            }
            onOpenChange={(open) => setOpenMemberId(open ? member.id : undefined)}
          >
            <Button
              data-channel-member-status={member.id}
              data-state={state}
              size="small"
              type="text"
              aria-label={t('receipt.memberLabel', {
                name: member.name,
                state: t(`receipt.state.${state}`),
              })}
            >
              <Avatar avatar={member.config.avatar || '🤖'} size={24} title={member.name} />
              <span
                aria-hidden
                className={`${styles.state} ${styles.memberDot}`}
                data-tone={receiptTone(state)}
              >
                <span className={styles.dot} />
              </span>
            </Button>
          </Popover>
        );
      })}
      {!data.channel.archived && (
        <ActionIcon
          aria-label={t('addMembers')}
          disabled={members.length >= CHANNEL_LIMITS.members}
          icon={Plus}
          size="small"
          title={t('addMembers')}
          onClick={addMembers}
        />
      )}
    </Flexbox>
  );
}

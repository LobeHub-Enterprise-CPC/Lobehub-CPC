import type { TaskDetailActivity } from '@lobechat/types';
import { formatDuration } from '@lobechat/utils';
import {
  ActionIcon,
  Button,
  confirmModal,
  DropdownMenu,
  Flexbox,
  Tag,
  Text,
  toast,
} from '@lobehub/ui';
import dayjs from 'dayjs';
import { CircleStop, Copy, ExternalLink, MoreHorizontal, Trash } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { usePermission } from '@/hooks/usePermission';
import { useTaskStore } from '@/store/task';

import TopicStatusIcon from '../AgentTaskDetail/TopicStatusIcon';
import AssigneeAvatar from '../features/AssigneeAvatar';
import { styles } from './style';

export const ScheduledRunRow = ({
  run,
  agentId,
  taskName,
  onOpen,
  onRemoved,
  onChanged,
}: {
  run: TaskDetailActivity;
  agentId?: string;
  taskName?: string;
  onOpen: () => void;
  onRemoved: (topicId: string) => void;
  onChanged: () => void;
}) => {
  const { t } = useTranslation('chat');
  const { allowed } = usePermission('create_content');
  const [busy, setBusy] = useState(false);
  const running = run.status === 'running';
  const mutate = (action: 'stop' | 'delete') => {
    if (!allowed || !run.id || busy) return;
    const topicId = run.id;
    confirmModal({
      title: t(`taskDetail.topicMenu.${action}Confirm.title`),
      content: t(`taskDetail.topicMenu.${action}Confirm.content`),
      cancelText: t('cancel', { ns: 'common' }),
      okText: t(`taskDetail.topicMenu.${action}`),
      okButtonProps: { danger: true },
      onOk: async () => {
        setBusy(true);
        try {
          if (action === 'stop') await useTaskStore.getState().cancelTopic(topicId);
          else {
            await useTaskStore.getState().deleteTopic(topicId);
            onRemoved(topicId);
          }
          onChanged();
        } catch (error) {
          toast.error(t('operationFailed', { ns: 'common' }));
          throw error;
        } finally {
          setBusy(false);
        }
      },
    });
  };
  const copyId = async () => {
    if (!run.id) return;
    try {
      await navigator.clipboard.writeText(run.id);
      toast.success(t('copySuccess', { ns: 'common' }));
    } catch {
      toast.error(t('operationFailed', { ns: 'common' }));
    }
  };
  return (
    <div className={styles.run} data-testid="scheduled-run-row">
      <Button
        type="text"
        className={styles.runOpen}
        onClick={onOpen}
        aria-label={run.title || taskName}
      >
        <Flexbox horizontal align="center" gap={10} style={{ minWidth: 0, flex: 1 }}>
          <AssigneeAvatar agentId={run.agentId || agentId} size={24} />
          <span
            aria-label={t(
              running
                ? 'scheduledTasks.running'
                : run.status === 'completed'
                  ? 'scheduledTasks.completed'
                  : run.status === 'canceled'
                    ? 'taskDetail.status.canceled'
                    : 'scheduledTasks.failed',
            )}
          >
            <TopicStatusIcon status={run.status} />
          </span>
          <Text ellipsis style={{ minWidth: 0 }}>
            {run.title || taskName}
          </Text>
          <Text fontSize={12} type="secondary">
            #{run.seq}
          </Text>
          <Tag>
            {t(
              run.trigger === 'manual'
                ? 'scheduledTasks.manualTrigger'
                : 'scheduledTasks.scheduledTrigger',
            )}
          </Tag>
          {run.time && run.completedAt && (
            <Text fontSize={12} type="secondary">
              {formatDuration(
                Math.max(0, new Date(run.completedAt).getTime() - new Date(run.time).getTime()),
              )}
            </Text>
          )}
        </Flexbox>
        <Text className={styles.runDate} fontSize={12} type="secondary">
          {run.time ? dayjs(run.time).format('MM-DD HH:mm') : ''}
        </Text>
      </Button>
      <DropdownMenu
        items={[
          ...(running
            ? [
                {
                  key: 'stop',
                  icon: CircleStop,
                  danger: true,
                  disabled: !allowed || busy,
                  label: t('taskDetail.topicMenu.stop'),
                  onClick: () => mutate('stop'),
                },
                { type: 'divider' as const },
              ]
            : []),
          {
            key: 'open',
            icon: ExternalLink,
            label: t('taskDetail.topicMenu.open'),
            onClick: onOpen,
          },
          {
            key: 'copy',
            icon: Copy,
            label: t('taskDetail.topicMenu.copyId'),
            onClick: () => {
              void copyId();
            },
          },
          { type: 'divider' },
          {
            key: 'delete',
            icon: Trash,
            danger: true,
            disabled: !allowed || busy,
            label: t('taskDetail.topicMenu.delete'),
            onClick: () => mutate('delete'),
          },
        ]}
      >
        <ActionIcon
          icon={MoreHorizontal}
          disabled={busy}
          aria-label={t('scheduledTasks.runActions', { title: run.title || taskName })}
        />
      </DropdownMenu>
    </div>
  );
};

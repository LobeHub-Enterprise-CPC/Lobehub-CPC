import type { TaskDetailActivity } from '@lobechat/types';
import {
  ActionIcon,
  Alert,
  Button,
  Divider,
  DropdownMenu,
  Flexbox,
  Skeleton,
  Text,
} from '@lobehub/ui';
import { ArrowLeft, MoreHorizontal, Pencil, Play } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import AsyncError from '@/components/AsyncError';
import { usePermission } from '@/hooks/usePermission';
import { useTaskStore } from '@/store/task';
import { taskDetailSelectors } from '@/store/task/selectors';

import { useActiveTaskDetail } from '../AgentTaskDetail/useActiveTaskDetail';
import { ScheduledRunRow } from './ScheduledRunRow';
import { createScheduledTaskModal } from './ScheduledTaskForm';
import { ScheduledTaskProperties } from './ScheduledTaskProperties';
import { styles } from './style';

export const ScheduledTaskDetail = ({
  compactActions = false,
  onRunRemoved,
  onBack,
  onOpenRun,
  onSaved,
  projectName,
  taskId,
}: {
  compactActions?: boolean;
  onRunRemoved: (topicId: string) => void;
  onBack?: () => void;
  onOpenRun: (run: TaskDetailActivity, agentId: string) => void;
  onSaved: () => void;
  projectName?: string;
  taskId: string;
}) => {
  const { t } = useTranslation('chat');
  const { error, isInitialLoading, isNotFound, onRetry } = useActiveTaskDetail(taskId);
  const detail = useTaskStore(taskDetailSelectors.activeTaskDetail);

  const { allowed } = usePermission('create_content');
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState(false);
  if (error) return <AsyncError error={error} onRetry={onRetry} />;
  if (isNotFound) return <Text>{t('taskDetail.notFound.desc')}</Text>;
  if (isInitialLoading || !detail || detail.identifier !== taskId)
    return <Skeleton.Text rows={8} />;
  const runs = (detail.activities || [])
    .filter((a) => a.type === 'topic' && a.id)
    .sort((a, b) => new Date(b.time || 0).getTime() - new Date(a.time || 0).getTime());
  const paused = detail.status === 'paused';
  const running = detail.status === 'running';
  const act = async (runNow: boolean) => {
    setBusy(true);
    setActionError(false);
    try {
      if (runNow) await useTaskStore.getState().runTask(taskId);
      else await useTaskStore.getState().updateTaskStatus(taskId, paused ? 'scheduled' : 'paused');
      onSaved();
    } catch {
      setActionError(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Flexbox gap={24}>
      <Flexbox horizontal align="start" gap={12} justify="space-between" wrap="wrap">
        <Flexbox horizontal align="center" gap={8} style={{ minWidth: 0 }}>
          {onBack && (
            <ActionIcon aria-label={t('scheduledTasks.back')} icon={ArrowLeft} onClick={onBack} />
          )}
          <Text as="h1" fontSize={24} style={{ margin: 0, overflowWrap: 'anywhere' }} weight={600}>
            {detail.name || detail.identifier}
          </Text>
        </Flexbox>
        <Flexbox horizontal gap={8} wrap="wrap">
          <Button
            aria-label={t('scheduledTasks.runNow')}
            className={styles.pill}
            disabled={!allowed || busy || running}
            icon={Play}
            loading={busy}
            style={compactActions ? { width: 40, padding: 0 } : undefined}
            onClick={() => void act(true)}
          >
            {!compactActions && t('scheduledTasks.runNow')}
          </Button>
          <Button
            aria-label={t('scheduledTasks.edit')}
            className={styles.pill}
            disabled={!allowed || running}
            icon={Pencil}
            style={compactActions ? { width: 40, padding: 0 } : undefined}
            onClick={() => createScheduledTaskModal({ task: detail, onSaved })}
          >
            {!compactActions && t('scheduledTasks.edit')}
          </Button>
          <DropdownMenu
            items={[
              {
                key: 'pause',
                label: t(paused ? 'scheduledTasks.resume' : 'scheduledTasks.pause'),
                disabled: !allowed || busy || running,
                onClick: () => void act(false),
              },
            ]}
          >
            <ActionIcon aria-label={t('scheduledTasks.taskActions')} icon={MoreHorizontal} />
          </DropdownMenu>
        </Flexbox>
      </Flexbox>
      {actionError && (
        <Alert
          showIcon
          aria-label={t('scheduledTasks.actionFailed')}
          title={t('scheduledTasks.actionFailed')}
          type="error"
        />
      )}
      {detail.error && <Alert showIcon title={detail.error} type="error" />}
      <Flexbox gap={8}>
        <Text fontSize={12} type="secondary">
          {t('scheduledTasks.description')}
        </Text>
        <div className={`${styles.description} ${expanded ? '' : styles.clamped}`}>
          {detail.instruction}
        </div>
        {detail.instruction.length > 160 && (
          <Button
            size="small"
            style={{ alignSelf: 'start' }}
            type="text"
            onClick={() => setExpanded(!expanded)}
          >
            {t(expanded ? 'scheduledTasks.showLess' : 'scheduledTasks.showAll')}
          </Button>
        )}
      </Flexbox>
      <ScheduledTaskProperties detail={detail} projectName={projectName} />
      <Divider style={{ margin: 0 }} />
      <Flexbox gap={12}>
        <Flexbox horizontal align="center" gap={8}>
          <Text weight={500}>{t('scheduledTasks.history')}</Text>
          <Text type="secondary">{detail.topicCount ?? runs.length}</Text>
        </Flexbox>
        {runs.length === 0 ? (
          <Text type="secondary">{t('scheduledTasks.noRuns')}</Text>
        ) : (
          runs.map((run) => (
            <ScheduledRunRow
              agentId={detail.agentId || undefined}
              key={run.id}
              run={run}
              taskName={detail.name || undefined}
              onChanged={onSaved}
              onOpen={() => onOpenRun(run, run.agentId || detail.agentId || '')}
              onRemoved={onRunRemoved}
            />
          ))
        )}
      </Flexbox>
    </Flexbox>
  );
};

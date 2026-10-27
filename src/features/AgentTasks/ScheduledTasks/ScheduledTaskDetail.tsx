import type { TaskDetailActivity } from '@lobechat/types';
import { formatDuration } from '@lobechat/utils';
import {
  ActionIcon,
  Alert,
  Button,
  Divider,
  Flexbox,
  Icon,
  Skeleton,
  Tag,
  Text,
} from '@lobehub/ui';
import dayjs from 'dayjs';
import { ArrowLeft, Clock, Pause, Play } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import AsyncError from '@/components/AsyncError';
import { usePermission } from '@/hooks/usePermission';
import { useTaskStore } from '@/store/task';
import { taskDetailSelectors } from '@/store/task/selectors';

import TaskExecutionConfig from '../AgentTaskDetail/TaskExecutionConfig';
import TaskModelConfig from '../AgentTaskDetail/TaskModelConfig';
import { useActiveTaskDetail } from '../AgentTaskDetail/useActiveTaskDetail';
import TaskScheduleConfig from '../AgentTaskDetail/TaskScheduleConfig';
import { useAgentDisplayMeta } from '../shared/useAgentDisplayMeta';
import { createScheduledTaskModal } from './ScheduledTaskForm';
import { scheduleSummary } from './scheduleSummary';
import { styles } from './style';

export const ScheduledTaskDetail = ({
  onBack,
  onOpenRun,
  onSaved,
  projectName,
  taskId,
}: {
  onBack: () => void;
  onOpenRun: (run: TaskDetailActivity, agentId: string) => void;
  onSaved: () => void;
  projectName?: string;
  taskId: string;
}) => {
  const { t } = useTranslation('chat');
  const { error, isInitialLoading, isNotFound, onRetry } = useActiveTaskDetail(taskId);
  const detail = useTaskStore(taskDetailSelectors.activeTaskDetail);
  const meta = useAgentDisplayMeta(detail?.agentId);
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
  const schedule = detail.config?.schedule as { endsAt?: string | null } | undefined;
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
          <ActionIcon icon={ArrowLeft} aria-label={t('scheduledTasks.back')} title={t('scheduledTasks.back')} onClick={onBack} />
          <Text as="h1" fontSize={24} style={{ margin: 0, overflowWrap: 'anywhere' }} weight={600}>
            {detail.name || detail.identifier}
          </Text>
        </Flexbox>
        <Flexbox horizontal gap={8} wrap="wrap">
          <Button
            disabled={!allowed || busy || running}
            icon={Play}
            loading={busy}
            onClick={() => void act(true)}
          >
            {t('scheduledTasks.runNow')}
          </Button>
          <Button
            disabled={!allowed || busy || running}
            icon={paused ? Play : Pause}
            onClick={() => void act(false)}
          >
            {t(paused ? 'scheduledTasks.resume' : 'scheduledTasks.pause')}
          </Button>
          <Button
            disabled={!allowed || running}
            onClick={() => createScheduledTaskModal({ task: detail, onSaved })}
          >
            {t('scheduledTasks.edit')}
          </Button>
        </Flexbox>
      </Flexbox>
      {actionError && <Alert showIcon aria-label={t('scheduledTasks.actionFailed')} title={t('scheduledTasks.actionFailed')} type="error" />}
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
      <div className={styles.properties}>
        <Flexbox gap={8}>
          <Text fontSize={12} type="secondary">
            {t('scheduledTasks.frequency')}
          </Text>
          <Text>
            {detail.automationMode === 'heartbeat' ? <TaskScheduleConfig taskId={detail.identifier} /> : scheduleSummary(detail.schedule?.pattern, detail.schedule?.timezone, detail.config, t)}
          </Text>
          <Text fontSize={12} type="secondary">
            {detail.schedule?.timezone}
          </Text>
          {schedule?.endsAt && (
            <Text fontSize={12}>
              {t('scheduledTasks.until', {
                date: dayjs(schedule.endsAt)
                  .tz(detail.schedule?.timezone || 'UTC')
                  .format('YYYY-MM-DD'),
              })}
            </Text>
          )}
        </Flexbox>
        <Flexbox gap={8}>
          <Text fontSize={12} type="secondary">
            {t('scheduledTasks.agent')}
          </Text>
          <Text>{meta?.title || t('scheduledTasks.inheritModel')}</Text>
        </Flexbox>
        <Flexbox gap={8}>
          <Text fontSize={12} type="secondary">
            {t('scheduledTasks.model')}
          </Text>
          <TaskModelConfig />
        </Flexbox>
        <Flexbox gap={8}>
          <Text fontSize={12} type="secondary">
            {t('scheduledTasks.project')}
          </Text>
          <Text>{projectName || t('scheduledTasks.none')}</Text>
        </Flexbox>
        <Flexbox gap={8}>
          <Text fontSize={12} type="secondary">
            {t('scheduledTasks.device')}
          </Text>
          <TaskExecutionConfig />
        </Flexbox>
        <Flexbox gap={8}>
          <Text fontSize={12} type="secondary">
            {t('scheduledTasks.advanced')}
          </Text>
          <Text>{t('scheduledTasks.newChat')}</Text>
        </Flexbox>
      </div>
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
            <Button
              block
              className={styles.run}
              key={run.id}
              onClick={() => onOpenRun(run, run.agentId || detail.agentId || '')}
            >
              <Flexbox
                horizontal
                align="center"
                gap={12}
                justify="space-between"
                style={{ width: '100%', minWidth: 0 }}
                wrap="wrap"
              >
                <Flexbox horizontal align="center" gap={8} style={{ minWidth: 0 }} wrap="wrap">
                  <Icon icon={Clock} size={16} />
                  <Text ellipsis>{run.title || detail.name}</Text>
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
                        new Date(run.completedAt).getTime() - new Date(run.time).getTime(),
                      )}
                    </Text>
                  )}
                </Flexbox>
                <Text fontSize={12} type="secondary">
                  {run.time ? dayjs(run.time).format('MM-DD HH:mm') : ''}
                </Text>
              </Flexbox>
            </Button>
          ))
        )}
      </Flexbox>
    </Flexbox>
  );
};

import { readTaskExecutionConfig, type TaskDetailData } from '@lobechat/types';
import { Flexbox, Text } from '@lobehub/ui';
import dayjs from 'dayjs';
import { useTranslation } from 'react-i18next';

import { ModelIcon } from '@/components/LobeIcons';
import { useAgentStore } from '@/store/agent';
import { useAiInfraStore, aiModelSelectors } from '@/store/aiInfra';
import { agentByIdSelectors } from '@/store/agent/selectors';

import { useTaskRunTarget, deviceLabel } from '../features/useTaskRunTarget';
import { useAgentDisplayMeta } from '../shared/useAgentDisplayMeta';
import { scheduleSummary } from './scheduleSummary';
import { styles } from './style';

export const ScheduledTaskProperties = ({
  detail,
  projectName,
}: {
  detail: TaskDetailData;
  projectName?: string;
}) => {
  const { t } = useTranslation('chat');
  const meta = useAgentDisplayMeta(detail.agentId);
  const model = useAgentStore((s) => agentByIdSelectors.getAgentModelById(detail.agentId || '')(s));
  const execution = readTaskExecutionConfig(detail.config);
  const target = useTaskRunTarget(detail.agentId || '', execution?.boundDeviceId);
  const pinned = target.devices?.find((device) => device.deviceId === target.pinnedDeviceId);
  const modelName = typeof detail.config?.model === 'string' ? detail.config.model : model;
  const provider = useAgentStore((s) =>
    agentByIdSelectors.getAgentModelProviderById(detail.agentId || '')(s),
  );
  const displayName =
    useAiInfraStore(
      (s) =>
        aiModelSelectors.getModelCard(
          modelName || '',
          typeof detail.config?.provider === 'string' ? detail.config.provider : provider || '',
        )(s)?.displayName,
    ) || modelName;
  const schedule = detail.config?.schedule as
    { endsAt?: string; newChatPerRun?: boolean; archiveSuccessfulRuns?: boolean } | undefined;
  const properties = [
    {
      label: t('scheduledTasks.executionFrequency'),
      value: (
        <Flexbox gap={4}>
          <Text>
            {detail.automationMode === 'heartbeat'
              ? t('taskSchedule.summary.heartbeat', {
                  interval: `${(detail.heartbeat?.interval || 0) / 60} ${t('taskSchedule.minutes')}`,
                })
              : scheduleSummary(
                  detail.schedule?.pattern,
                  detail.schedule?.timezone,
                  detail.config,
                  t,
                )}
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
      ),
    },
    { label: t('scheduledTasks.agent'), value: meta?.title || t('scheduledTasks.inheritModel') },
    {
      label: t('scheduledTasks.model'),
      value: (
        <div className={styles.summaryValue}>
          {modelName && <ModelIcon model={modelName} size={20} />}
          <Text ellipsis title={displayName}>
            {displayName || t('scheduledTasks.inheritModel')}
          </Text>
        </div>
      ),
    },
    { label: t('scheduledTasks.project'), value: projectName || t('scheduledTasks.none') },
    {
      label: t('scheduledTasks.device'),
      value: pinned
        ? deviceLabel(pinned, target.inheritedLabel)
        : target.inheritedLabel || t('taskExecution.followAgent'),
    },
    {
      label: t('scheduledTasks.otherSettings'),
      value: [
        t(
          schedule?.newChatPerRun === false ? 'scheduledTasks.reuseChat' : 'scheduledTasks.newChat',
        ),
        ...(schedule?.archiveSuccessfulRuns ? [t('scheduledTasks.archiveRuns')] : []),
      ].join(' · '),
    },
  ];
  return (
    <div className={styles.properties}>
      {properties.map(({ label, value }) => (
        <Flexbox gap={8} key={label}>
          <Text fontSize={12} type="secondary">
            {label}
          </Text>
          <div>{value}</div>
        </Flexbox>
      ))}
    </div>
  );
};

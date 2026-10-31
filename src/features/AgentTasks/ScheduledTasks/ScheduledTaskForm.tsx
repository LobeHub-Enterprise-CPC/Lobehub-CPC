import type { TaskDetailData, TaskExecutionConfig } from '@lobechat/types';
import { readTaskExecutionConfig, toTaskExecutionConfigPatch } from '@lobechat/types';
import {
  Alert,
  Button,
  createModal,
  Flexbox,
  Icon,
  Input,
  Select,
  Switch,
  Text,
  TextArea,
  useModalContext,
} from '@lobehub/ui';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import ModelSelect from '@/features/ModelSelect';
import { usePermission } from '@/hooks/usePermission';
import { taskService } from '@/services/task';
import { useAgentStore } from '@/store/agent';
import { agentByIdSelectors, builtinAgentSelectors } from '@/store/agent/selectors';
import { useCurrentProjectList, useProjectStore } from '@/store/project';
import { useTaskStore } from '@/store/task';

import { TIMEZONE_OPTIONS } from '../AgentTaskDetail/scheduler/CronConfig';
import AssigneeAgentSelector from '../features/AssigneeAgentSelector';
import TaskDeviceChip from '../features/TaskDeviceChip';
import { useAgentDisplayMeta } from '../shared/useAgentDisplayMeta';
import { FieldRow } from './FieldRow';
import { ScheduleFields } from './ScheduleFields';
import type { ScheduleFrequency } from './scheduleForm';
import { buildSchedule, initialSchedule, validateScheduleForm } from './scheduleForm';
import { styles } from './style';

interface ScheduledTaskFormProps {
  agentId?: string;
  initialFrequency?: ScheduleFrequency;
  initialInstruction?: string;
  lockAssignee?: boolean;
  onSaved?: (task: { identifier: string; agentId?: string; name?: string }) => void;
  projectId?: string;
  task?: TaskDetailData;
}

export const ScheduledTaskForm = ({
  agentId,
  lockAssignee,
  initialInstruction,
  initialFrequency,
  onSaved,
  projectId,
  task,
}: ScheduledTaskFormProps) => {
  const { t } = useTranslation('chat');
  const { close, setCanDismissByClickOutside } = useModalContext();
  const { allowed } = usePermission('create_content');
  const inboxId = useAgentStore(builtinAgentSelectors.inboxAgentId);
  const [instruction, setInstruction] = useState(task?.instruction || initialInstruction || '');
  const [name, setName] = useState(task?.name || '');
  const [schedule, setSchedule] = useState(() => ({
    ...initialSchedule(task?.schedule?.pattern, task?.schedule?.timezone, task?.config),
    ...(!task && initialFrequency ? { frequency: initialFrequency } : {}),
  }));
  const [scheduleTouched, setScheduleTouched] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [assignee, setAssignee] = useState<string | undefined>(task?.agentId || agentId || inboxId);
  const [project, setProject] = useState(task?.projectId || projectId);
  const [newChatPerRun, setNewChatPerRun] = useState(
    (task?.config?.schedule as { newChatPerRun?: boolean } | undefined)?.newChatPerRun !== false,
  );
  const [archiveSuccessfulRuns, setArchiveSuccessfulRuns] = useState(
    task
      ? (task.config?.schedule as { archiveSuccessfulRuns?: boolean } | undefined)
          ?.archiveSuccessfulRuns === true
      : true,
  );
  const [execution, setExecution] = useState<TaskExecutionConfig | undefined>(() =>
    readTaskExecutionConfig(task?.config),
  );
  const [model, setModel] = useState<{ model: string; provider: string } | undefined>(() =>
    typeof task?.config?.model === 'string' && typeof task?.config?.provider === 'string'
      ? { model: task.config.model, provider: task.config.provider }
      : undefined,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const meta = useAgentDisplayMeta(assignee);
  const agentModel = useAgentStore((s) => agentByIdSelectors.getAgentModelById(assignee || '')(s));
  const agentProvider = useAgentStore((s) =>
    agentByIdSelectors.getAgentModelProviderById(assignee || '')(s),
  );
  const projects = useCurrentProjectList();
  useProjectStore((s) => s.useFetchProjectList)();
  const save = async () => {
    if (!allowed || busy) return;
    if (!instruction.trim()) {
      setError(t('scheduledTasks.required'));
      return;
    }
    const invalid = validateScheduleForm(schedule);
    if ((!task || scheduleTouched) && invalid) {
      setError(t(`scheduledTasks.${invalid}`));
      return;
    }
    setBusy(true);
    setError('');
    setCanDismissByClickOutside(false);
    try {
      // An untouched edit keeps the stored schedule as it is.
      const built = !task || scheduleTouched ? buildSchedule(schedule) : undefined;
      const config = {
        ...model,
        execution: toTaskExecutionConfigPatch(execution || {}),
        schedule: {
          ...((task?.config?.schedule || {}) as object),
          ...built?.schedule,
          newChatPerRun,
          archiveSuccessfulRuns,
        },
      };
      let identifier: string;
      if (task) {
        // One atomic write: an edit never saves half of the form or changes status.
        await taskService.update(task.identifier, {
          assigneeAgentId: assignee,
          configPatch: {
            ...config,
            ...(model || { model: null, provider: null }),
            ...(!scheduleTouched
              ? {
                  schedule: {
                    ...((task.config?.schedule || {}) as object),
                    newChatPerRun,
                    archiveSuccessfulRuns,
                  },
                }
              : {}),
          },
          ...(instruction !== (task.instruction || '') ? { instruction: instruction.trim() } : {}),
          name: name.trim() || instruction.trim().slice(0, 60),
          ...(built
            ? { schedulePattern: built.schedulePattern, scheduleTimezone: built.scheduleTimezone }
            : {}),
        });
        await useTaskStore.getState().internal_refreshTaskDetail(task.identifier);
        identifier = task.identifier;
      } else {
        const created = await useTaskStore.getState().createTask({
          assigneeAgentId: assignee,
          automationMode: 'schedule',
          config,
          instruction: instruction.trim(),
          name: instruction.trim().slice(0, 60),
          projectId: project,
          schedulePattern: built?.schedulePattern,
          scheduleTimezone: built?.scheduleTimezone,
        });
        if (!created) throw new Error('No task returned');
        identifier = created.identifier;
      }
      await useTaskStore.getState().refreshTaskList();
      onSaved?.({ identifier, agentId: assignee, name: name || instruction.slice(0, 60) });
      close();
    } catch {
      setError(t('scheduledTasks.saveFailed'));
    } finally {
      setBusy(false);
      setCanDismissByClickOutside(true);
    }
  };
  return (
    <form
      className={styles.form}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className={styles.formBody}>
        {task && (
          <Flexbox gap={8}>
            <label htmlFor="schedule-name">{t('scheduledTasks.name')}</label>
            <Input
              disabled={busy}
              id="schedule-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Flexbox>
        )}
        <Flexbox gap={8}>
          <label htmlFor="schedule-instruction">
            <Text fontSize={12} type="secondary">
              {t('scheduledTasks.description')}
            </Text>
          </label>
          <TextArea
            autoFocus
            disabled={busy}
            id="schedule-instruction"
            placeholder={t('scheduledTasks.placeholder')}
            rows={3}
            style={{ minHeight: 92, resize: 'vertical' }}
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
          />
        </Flexbox>
        <fieldset
          disabled={busy || !allowed}
          style={{ border: 0, margin: 0, minWidth: 0, padding: 0 }}
        >
          {task?.automationMode === 'heartbeat' ? (
            <Text>
              {t('taskSchedule.summary.heartbeat', {
                interval: `${(task.heartbeat?.interval || 0) / 60} ${t('taskSchedule.minutes')}`,
              })}
            </Text>
          ) : (
            <ScheduleFields
              value={schedule}
              onChange={(value) => {
                setSchedule(value);
                setScheduleTouched(true);
              }}
            />
          )}
        </fieldset>
        <Flexbox gap={8}>
          <Button
            aria-controls="schedule-advanced"
            aria-expanded={advanced}
            className={styles.advancedToggle}
            type="text"
            onClick={() => setAdvanced(!advanced)}
          >
            {t('scheduledTasks.advanced')}
            <Icon icon={advanced ? ChevronUp : ChevronDown} size={12} />
          </Button>
          {advanced && (
            <Flexbox gap={8} id="schedule-advanced">
              <FieldRow label={t('scheduledTasks.newChat')}>
                <Switch
                  aria-label={t('scheduledTasks.newChat')}
                  checked={newChatPerRun}
                  disabled={busy}
                  onChange={setNewChatPerRun}
                />
              </FieldRow>
              <FieldRow label={t('scheduledTasks.archiveRuns')}>
                <Switch
                  aria-label={t('scheduledTasks.archiveRuns')}
                  checked={archiveSuccessfulRuns}
                  disabled={busy}
                  onChange={setArchiveSuccessfulRuns}
                />
              </FieldRow>
              <FieldRow id="schedule-project" label={t('scheduledTasks.project')}>
                <Select
                  disabled={!!task || !!projectId || busy}
                  id="schedule-project"
                  style={{ width: 'auto', maxWidth: '70%', minWidth: 120 }}
                  suffixIcon={null}
                  value={project || 'none'}
                  variant="borderless"
                  options={[
                    { label: t('scheduledTasks.none'), value: 'none' },
                    ...projects.map((p) => ({ label: p.name, value: p.id })),
                  ]}
                  onChange={(value) => {
                    setProject(value === 'none' ? undefined : value);
                    setExecution(undefined);
                  }}
                />
              </FieldRow>
              <FieldRow label={t('scheduledTasks.device')}>
                {assignee ? (
                  <TaskDeviceChip
                    agentId={assignee}
                    disabled={busy || !!project}
                    value={execution?.boundDeviceId}
                    onChange={(boundDeviceId) =>
                      setExecution(boundDeviceId ? { boundDeviceId } : undefined)
                    }
                  />
                ) : (
                  <Text>{t('taskExecution.followAgent')}</Text>
                )}
              </FieldRow>
              <AssigneeAgentSelector
                allowUnassigned={false}
                currentAgentId={assignee}
                disabled={lockAssignee || busy}
                onChange={(id) => {
                  setAssignee(id || undefined);
                  setExecution(undefined);
                  setModel(undefined);
                }}
              >
                <div className={styles.row} style={{ width: '100%' }}>
                  <Text>{t('scheduledTasks.agent')}</Text>
                  <Text ellipsis>{meta?.title || t('scheduledTasks.inheritModel')}</Text>
                </div>
              </AssigneeAgentSelector>
              <FieldRow id="schedule-model" label={t('scheduledTasks.model')}>
                <ModelSelect
                  initialWidth
                  disabled={busy}
                  id="schedule-model"
                  placeholder={t('scheduledTasks.inheritModel')}
                  variant="borderless"
                  value={
                    model ||
                    (agentModel && agentProvider
                      ? { model: agentModel, provider: agentProvider }
                      : undefined)
                  }
                  onChange={setModel}
                />
              </FieldRow>
              <FieldRow id="schedule-timezone" label={t('taskSchedule.timezone')}>
                <Select
                  showSearch
                  id="schedule-timezone"
                  style={{ maxWidth: '70%', textAlign: 'end' }}
                  suffixIcon={null}
                  value={schedule.timezone}
                  variant="borderless"
                  options={
                    TIMEZONE_OPTIONS.some((tz) => tz.value === schedule.timezone)
                      ? TIMEZONE_OPTIONS
                      : [
                          { label: schedule.timezone, value: schedule.timezone },
                          ...TIMEZONE_OPTIONS,
                        ]
                  }
                  onChange={(timezone) => {
                    setSchedule({ ...schedule, timezone });
                    setScheduleTouched(true);
                  }}
                />
              </FieldRow>
            </Flexbox>
          )}
        </Flexbox>
      </div>
      {error && <Alert showIcon title={error} type="error" />}
      <div className={styles.footer}>
        <Button className={styles.pill} disabled={busy} onClick={() => close()}>
          {t('scheduledTasks.cancel')}
        </Button>
        <Button
          className={styles.pill}
          disabled={!allowed || !instruction.trim()}
          htmlType="submit"
          loading={busy}
          type="primary"
        >
          {t(task ? 'scheduledTasks.saveAction' : 'scheduledTasks.createAction')}
        </Button>
      </div>
    </form>
  );
};

export const createScheduledTaskModal = (props: ScheduledTaskFormProps = {}) =>
  createModal({
    content: <ScheduledTaskForm {...props} />,
    footer: null,
    maskClosable: false,
    title: <ScheduledTaskModalTitle editing={!!props.task} />,
    width: 'min(520px, calc(100vw - 24px))',
    styles: {
      popup: { maxHeight: 'calc(100dvh - 32px)', display: 'flex', flexDirection: 'column' },
      header: { padding: '24px 24px 20px' },
      content: {
        display: 'flex',
        flexDirection: 'column',
        maxHeight: 'calc(100dvh - 112px)',
        overflow: 'hidden',
        padding: '0 24px 24px',
      },
    },
  });

const ScheduledTaskModalTitle = ({ editing }: { editing: boolean }) => {
  const { t } = useTranslation('chat');
  return <>{t(editing ? 'scheduledTasks.edit' : 'scheduledTasks.create')}</>;
};

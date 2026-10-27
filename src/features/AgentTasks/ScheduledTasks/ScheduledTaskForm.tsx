import type { TaskDetailData, TaskExecutionConfig } from '@lobechat/types';
import { readTaskExecutionConfig, toTaskExecutionConfigPatch } from '@lobechat/types';
import {
  Alert,
  Block,
  Button,
  createModal,
  Flexbox,
  Input,
  Select,
  Text,
  TextArea,
  useModalContext,
} from '@lobehub/ui';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import ModelSelect from '@/features/ModelSelect';
import { usePermission } from '@/hooks/usePermission';
import { taskService } from '@/services/task';
import { useAgentStore } from '@/store/agent';
import { builtinAgentSelectors } from '@/store/agent/selectors';
import { useCurrentProjectList, useProjectStore } from '@/store/project';
import { useTaskStore } from '@/store/task';

import AssigneeAgentSelector from '../features/AssigneeAgentSelector';
import TaskExecutionControls from '../features/TaskExecutionControls';
import { useAgentDisplayMeta } from '../shared/useAgentDisplayMeta';
import { FieldRow } from './FieldRow';
import { ScheduleFields } from './ScheduleFields';
import { buildSchedule, initialSchedule, validateScheduleForm } from './scheduleForm';
import { styles } from './style';

interface ScheduledTaskFormProps {
  agentId?: string;
  lockAssignee?: boolean;
  onSaved?: (task: { identifier: string; agentId?: string; name?: string }) => void;
  projectId?: string;
  task?: TaskDetailData;
}

export const ScheduledTaskForm = ({
  agentId,
  lockAssignee,
  onSaved,
  projectId,
  task,
}: ScheduledTaskFormProps) => {
  const { t } = useTranslation('chat');
  const { close, setCanDismissByClickOutside } = useModalContext();
  const { allowed } = usePermission('create_content');
  const inboxId = useAgentStore(builtinAgentSelectors.inboxAgentId);
  const [instruction, setInstruction] = useState(task?.instruction || '');
  const [name, setName] = useState(task?.name || '');
  const [schedule, setSchedule] = useState(() =>
    initialSchedule(task?.schedule?.pattern, task?.schedule?.timezone, task?.config),
  );
  const [scheduleTouched, setScheduleTouched] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [assignee, setAssignee] = useState(task?.agentId || agentId || inboxId);
  const [project, setProject] = useState(projectId);
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
      const built = buildSchedule(schedule);
      const config = {
        ...model,
        execution: toTaskExecutionConfigPatch(execution || {}),
        schedule: { ...((task?.config?.schedule || {}) as object), ...built.schedule },
      };
      let identifier: string;
      if (task) {
        // One atomic write: an edit never saves half of the form or changes status.
        await taskService.update(task.identifier, {
          assigneeAgentId: assignee,
          configPatch: {
            ...config,
            ...(!scheduleTouched ? { schedule: task.config?.schedule || {} } : {}),
          },
          ...(instruction !== (task.instruction || '') ? { instruction: instruction.trim() } : {}),
          name: name.trim() || instruction.trim().slice(0, 60),
          ...(scheduleTouched
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
          schedulePattern: built.schedulePattern,
          scheduleTimezone: built.scheduleTimezone,
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
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
          />
        </Flexbox>
        <fieldset
          disabled={busy || !allowed}
          style={{ border: 0, margin: 0, minWidth: 0, padding: 0 }}
        >
          {task?.automationMode === 'heartbeat' ? <Text>{t('taskSchedule.summary.heartbeat', { interval: `${(task.heartbeat?.interval || 0) / 60} ${t('taskSchedule.minutes')}` })}</Text> : <ScheduleFields
            value={schedule}
            onChange={(value) => {
              setSchedule(value);
              setScheduleTouched(true);
            }}
          />}
        </fieldset>
        <Button block aria-expanded={advanced} type="text" onClick={() => setAdvanced(!advanced)}>
          {t('scheduledTasks.advanced')}
        </Button>
        {advanced && (
          <Flexbox gap={8}>
            {!task && (
              <FieldRow id="schedule-project" label={t('scheduledTasks.project')}>
                <Select
                  disabled={!!projectId || busy}
                  id="schedule-project"
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
            )}
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
              <Block
                clickable
                horizontal
                align="center"
                className={styles.row}
                justify="space-between"
              >
                <Text>{t('scheduledTasks.agent')}</Text>
                <Text ellipsis>{meta?.title || t('scheduledTasks.inheritModel')}</Text>
              </Block>
            </AssigneeAgentSelector>
            <FieldRow label={t('scheduledTasks.model')}>
              <ModelSelect
                disabled={busy}
                model={model?.model || ''}
                provider={model?.provider || ''}
                onChange={setModel}
              />
            </FieldRow>
            <Flexbox gap={8}>
              <Text fontSize={12} type="secondary">
                {t('scheduledTasks.device')}
              </Text>
              <TaskExecutionControls
                assigneeAgentId={assignee}
                disabled={busy || !!project}
                value={execution}
                onChange={setExecution}
              />
            </Flexbox>
            <Text fontSize={12} type="secondary">
              {t('scheduledTasks.newChat')}
            </Text>
          </Flexbox>
        )}
        {error && <Alert showIcon title={error} type="error" />}
      </div>
      <div className={styles.footer}>
        <Button disabled={busy} onClick={() => close()}>
          {t('scheduledTasks.cancel')}
        </Button>
        <Button
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
      content: {
        display: 'flex',
        flexDirection: 'column',
        maxHeight: 'calc(100dvh - 140px)',
        overflow: 'hidden',
        padding: 24,
      },
    },
  });

const ScheduledTaskModalTitle = ({ editing }: { editing: boolean }) => {
  const { t } = useTranslation('chat');
  return <>{t(editing ? 'scheduledTasks.edit' : 'scheduledTasks.create')}</>;
};

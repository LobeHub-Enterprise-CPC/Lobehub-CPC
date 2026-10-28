import type { TaskDetailActivity } from '@lobechat/types';
import {
  ActionIcon,
  Alert,
  Button,
  DropdownMenu,
  Flexbox,
  Pagination,
  Skeleton,
  Text,
} from '@lobehub/ui';
import { ArrowLeft, MoreHorizontal, PencilLine, Search, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';

import { useWorkspaceAwareNavigate } from '@/features/Workspace/useWorkspaceAwareNavigate';
import { useIsMobile } from '@/hooks/useIsMobile';
import { usePermission } from '@/hooks/usePermission';
import { useGlobalStore } from '@/store/global';
import { useCurrentProjectList, useProjectStore } from '@/store/project';
import type { TaskListItem } from '@/store/task/slices/list/initialState';

import { TopicChatDrawerBody } from '../AgentTaskDetail/TopicChatDrawer';
import { SCHEDULE_FILTERS, type ScheduleFilter } from './filters';
import { ScheduledTaskDetail } from './ScheduledTaskDetail';
import { createScheduledTaskModal } from './ScheduledTaskForm';
import { ScheduledTasksWelcome, type SchedulePreset } from './ScheduledTasksWelcome';
import { formatScheduledDate, nextScheduledDate, scheduleSummary } from './scheduleSummary';
import { styles } from './style';

interface ScheduledTasksWorkspaceProps {
  agentId?: string;
  error?: unknown;
  filters: ScheduleFilter[];
  isLoading: boolean;
  items: TaskListItem[];
  onFiltersChange: (filters: ScheduleFilter[]) => void;
  onPageChange: (page: number) => void;
  onRefresh: () => void;
  page: number;
  pageSize: number;
  projectId?: string;
  total: number;
}

export const ScheduledTasksWorkspace = ({
  agentId,
  error,
  isLoading,
  items,
  filters,
  onFiltersChange,
  onPageChange,
  onRefresh,
  page,
  pageSize,
  projectId,
  total,
}: ScheduledTasksWorkspaceProps) => {
  const { t, i18n } = useTranslation('chat');
  const { allowed } = usePermission('create_content');
  const mobile = useIsMobile();
  const navigate = useWorkspaceAwareNavigate();
  const nativeMobile = typeof __MOBILE__ !== 'undefined' && __MOBILE__;
  const [params, setParams] = useSearchParams();
  const requestedId = params.get('scheduledTask');
  const mobileDetail = !!requestedId;
  const toggleCommandMenu = useGlobalStore((s) => s.toggleCommandMenu);
  const [run, setRun] = useState<{ activity: TaskDetailActivity; agentId: string }>();
  const selectedId = requestedId || undefined;
  const selected = items.find((task) => task.identifier === selectedId);
  const projects = useCurrentProjectList();
  useProjectStore((s) => s.useFetchProjectList)();
  useEffect(() => {
    setRun(undefined);
  }, [selectedId]);
  const select = (id?: string) => {
    const next = new URLSearchParams(params);
    if (id) next.set('scheduledTask', id);
    else next.delete('scheduledTask');
    setParams(next, { replace: true });
  };
  const create = (preset?: SchedulePreset) =>
    createScheduledTaskModal({
      agentId,
      lockAssignee: !!agentId,
      projectId,
      initialInstruction: preset?.instruction,
      initialFrequency: preset?.frequency,
      onSaved: ({ identifier }) => {
        onRefresh();
        const next = new URLSearchParams(params);
        next.set('scheduledTask', identifier);
        next.delete('scheduledStatus');
        next.delete('scheduledPage');
        setParams(next, { replace: true });
      },
    });
  const terminalLabel = (status: string) =>
    t(
      status === 'paused'
        ? 'scheduledTasks.paused'
        : status === 'running'
          ? 'scheduledTasks.running'
          : status === 'completed' || status === 'canceled'
            ? 'scheduledTasks.completed'
            : 'scheduledTasks.failed',
    );
  return (
    <div className={styles.root} data-testid="scheduled-workspace">
      {(!mobile || (!mobileDetail && !run)) && (
        <aside aria-label={t('scheduledTasks.title')} className={styles.sidebar}>
          <div className={styles.sidebarHeader}>
            <Flexbox horizontal align="center" gap={4}>
              {nativeMobile && (
                <ActionIcon
                  aria-label={t('tab.home', { ns: 'common' })}
                  icon={ArrowLeft}
                  onClick={() => navigate('/')}
                />
              )}
              <Text fontSize={16} weight={600}>
                {t('scheduledTasks.title')}
              </Text>
            </Flexbox>
            <ActionIcon
              aria-label={t('tab.search', { ns: 'common' })}
              icon={Search}
              title={t('tab.search', { ns: 'common' })}
              onClick={() => toggleCommandMenu(true)}
            />
          </div>
          <Button
            className={styles.createEntry}
            disabled={!allowed}
            icon={PencilLine}
            type="text"
            onClick={() => create()}
          >
            {t('scheduledTasks.newTask')}
          </Button>
          <Flexbox horizontal align="center" className={styles.listHeader} justify="space-between">
            <Text fontSize={12} type="secondary">
              {t('scheduledTasks.upcoming')}
            </Text>
            <DropdownMenu
              header={t('scheduledTasks.filterBy')}
              items={SCHEDULE_FILTERS.map((key) => ({
                key,
                type: 'checkbox',
                checked: filters.includes(key),
                closeOnClick: false,
                label: t(`scheduledTasks.filters.${key}`),
                onCheckedChange: (checked) =>
                  onFiltersChange(
                    SCHEDULE_FILTERS.filter((value) =>
                      value === key ? checked : filters.includes(value),
                    ),
                  ),
              }))}
            >
              <ActionIcon
                aria-label={t('scheduledTasks.filterBy')}
                icon={MoreHorizontal}
                title={t('scheduledTasks.filterBy')}
              />
            </DropdownMenu>
          </Flexbox>
          <div className={styles.list}>
            {error ? (
              <Alert
                action={<Button onClick={onRefresh}>{t('scheduledTasks.retry')}</Button>}
                aria-label={t('scheduledTasks.loadFailed')}
                title={t('scheduledTasks.loadFailed')}
                type="error"
              />
            ) : isLoading && items.length === 0 ? (
              <Skeleton.Text rows={5} />
            ) : items.length === 0 ? (
              <Flexbox gap={8} padding={8}>
                <Text type="secondary">
                  {t(
                    filters.length === SCHEDULE_FILTERS.length
                      ? 'scheduledTasks.empty'
                      : 'scheduledTasks.noFilterMatches',
                  )}
                </Text>
              </Flexbox>
            ) : (
              <Flexbox gap={8}>
                {[...items]
                  .sort(
                    (a, b) =>
                      Number(['paused', 'completed', 'canceled', 'failed'].includes(a.status)) -
                      Number(['paused', 'completed', 'canceled', 'failed'].includes(b.status)),
                  )
                  .map((task) => {
                    const active = task.identifier === selectedId;
                    const automated = task.status === 'scheduled' || task.status === 'backlog';
                    const next =
                      automated && task.automationMode === 'schedule'
                        ? nextScheduledDate(
                            task.schedulePattern,
                            task.scheduleTimezone,
                            task.config as Record<string, unknown>,
                          )
                        : null;
                    const summary =
                      task.automationMode === 'heartbeat'
                        ? t('taskSchedule.summary.heartbeat', {
                            interval: `${(task.heartbeatInterval || 0) / 60} ${t('taskSchedule.minutes')}`,
                          })
                        : scheduleSummary(
                            task.schedulePattern,
                            task.scheduleTimezone,
                            task.config as Record<string, unknown>,
                            t,
                          );
                    return (
                      <Button
                        aria-current={active ? 'page' : undefined}
                        className={`${styles.taskItem} ${active ? styles.selectedTask : ''} ${!automated && task.status !== 'running' ? styles.mutedTask : ''}`}
                        key={task.identifier}
                        type="text"
                        onClick={() => select(task.identifier)}
                      >
                        <Flexbox gap={2} style={{ width: '100%', minWidth: 0 }}>
                          <Text
                            ellipsis
                            fontSize={14}
                            style={{ color: 'inherit' }}
                            title={task.name || task.identifier}
                          >
                            {task.name || task.identifier}
                          </Text>
                          <Text ellipsis fontSize={12} type="secondary">
                            {automated
                              ? next
                                ? formatScheduledDate(
                                    next,
                                    task.scheduleTimezone,
                                    i18n.resolvedLanguage,
                                  )
                                : summary
                              : `${terminalLabel(task.status)} · ${summary}`}
                          </Text>
                        </Flexbox>
                      </Button>
                    );
                  })}
              </Flexbox>
            )}
          </div>
          {total > 0 && (total > pageSize || page > 1) && (
            <Flexbox padding={12}>
              <Pagination
                simple
                current={page}
                pageSize={pageSize}
                showSizeChanger={false}
                total={total}
                onChange={onPageChange}
              />
            </Flexbox>
          )}
          {total === 0 && page > 1 && !isLoading && (
            <Button onClick={() => onPageChange(page - 1)}>
              {t('scheduledTasks.previousPage')}
            </Button>
          )}
        </aside>
      )}
      {(!mobile || (mobileDetail && !run)) && (
        <main className={styles.detail} data-testid="scheduled-detail">
          {selectedId ? (
            <ScheduledTaskDetail
              compactActions={!!run}
              key={selectedId}
              projectName={projects.find((project) => project.id === selected?.projectId)?.name}
              taskId={selectedId}
              onBack={mobile || nativeMobile ? () => select(undefined) : undefined}
              onOpenRun={(activity, runAgentId) => setRun({ activity, agentId: runAgentId })}
              onSaved={onRefresh}
              onRunRemoved={(topicId) => {
                if (run?.activity.id === topicId) setRun(undefined);
              }}
            />
          ) : (
            <ScheduledTasksWelcome disabled={!allowed} onCreate={create} />
          )}
        </main>
      )}
      {run && (
        <section
          aria-label={run.activity.title || t('scheduledTasks.history')}
          className={styles.chat}
          data-testid="scheduled-chat"
        >
          <Flexbox horizontal align="center" gap={12} justify="space-between" padding={16}>
            <Text ellipsis weight={500}>
              {run.activity.title}
            </Text>
            <ActionIcon
              aria-label={t('scheduledTasks.closeChat')}
              icon={X}
              title={t('scheduledTasks.closeChat')}
              onClick={() => setRun(undefined)}
            />
          </Flexbox>
          <Flexbox flex={1} style={{ minHeight: 0 }}>
            <TopicChatDrawerBody
              defaultInputExpanded
              disableInputCollapse
              agentId={run.agentId}
              operationId={run.activity.operationId}
              runningOperation={run.activity.runningOperation}
              topicId={run.activity.id!}
            />
          </Flexbox>
        </section>
      )}
    </div>
  );
};

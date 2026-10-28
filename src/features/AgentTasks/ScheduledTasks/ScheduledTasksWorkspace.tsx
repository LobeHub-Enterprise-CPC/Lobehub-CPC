import type { TaskDetailActivity } from '@lobechat/types';
import { ActionIcon, Alert, Button, Flexbox, Pagination, Skeleton, Text } from '@lobehub/ui';
import { ArrowLeft, Plus, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';

import { useIsMobile } from '@/hooks/useIsMobile';
import { usePermission } from '@/hooks/usePermission';
import { useCurrentProjectList, useProjectStore } from '@/store/project';
import type { TaskListItem } from '@/store/task/slices/list/initialState';

import { TopicChatDrawerBody } from '../AgentTaskDetail/TopicChatDrawer';
import { ScheduledTaskDetail } from './ScheduledTaskDetail';
import { createScheduledTaskModal } from './ScheduledTaskForm';
import { formatScheduledDate, nextScheduledDate, scheduleSummary } from './scheduleSummary';
import { styles } from './style';

interface ScheduledTasksWorkspaceProps {
  agentId?: string;
  error?: unknown;
  isLoading: boolean;
  items: TaskListItem[];
  onExit: () => void;
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
  onExit,
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
  const [params, setParams] = useSearchParams();
  const requestedId = params.get('scheduledTask');
  const [mobileDetail, setMobileDetail] = useState(!!requestedId);
  const [run, setRun] = useState<{ activity: TaskDetailActivity; agentId: string }>();
  const selectedId = requestedId || (!mobile ? items[0]?.identifier : undefined);
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
    setMobileDetail(!!id);
  };
  const create = () =>
    createScheduledTaskModal({
      agentId,
      lockAssignee: !!agentId,
      projectId,
      onSaved: ({ identifier }) => {
        onRefresh();
        select(identifier);
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
              <ActionIcon
                icon={ArrowLeft}
                aria-label={t('taskList.title')}
                title={t('taskList.title')}
                onClick={onExit}
              />
              <Text weight={500}>{t('scheduledTasks.title')}</Text>
            </Flexbox>
            <ActionIcon
              disabled={!allowed}
              icon={Plus}
              aria-label={t('scheduledTasks.create')}
              title={t('scheduledTasks.create')}
              onClick={create}
            />
          </div>
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
              <Flexbox gap={16} paddingBlock={32}>
                <Text weight={500}>{t('scheduledTasks.empty')}</Text>
                <Text type="secondary">{t('scheduledTasks.emptyDescription')}</Text>
                <Button disabled={!allowed} icon={Plus} onClick={create}>
                  {t('scheduledTasks.create')}
                </Button>
              </Flexbox>
            ) : (
              <Flexbox gap={8}>
                <Text fontSize={12} style={{ paddingInline: 8 }} type="secondary">
                  {t('scheduledTasks.upcoming')}
                </Text>
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
                            title={task.name || task.identifier}
                            style={{ color: 'inherit' }}
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
          {total > pageSize && (
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
              onOpenRun={(activity, runAgentId) => setRun({ activity, agentId: runAgentId })}
              onSaved={onRefresh}
              onBack={() => {
                select(undefined);
                if (!mobile) onExit();
              }}
            />
          ) : (
            !error &&
            !isLoading && (
              <Flexbox align="center" gap={16} justify="center" style={{ minHeight: '60vh' }}>
                <Text type="secondary">
                  {t(total === 0 ? 'scheduledTasks.emptyDescription' : 'scheduledTasks.selectTask')}
                </Text>
                <Button disabled={!allowed} icon={Plus} onClick={create}>
                  {t('scheduledTasks.create')}
                </Button>
              </Flexbox>
            )
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
              icon={X}
              aria-label={t('scheduledTasks.closeChat')}
              title={t('scheduledTasks.closeChat')}
              onClick={() => setRun(undefined)}
            />
          </Flexbox>
          <Flexbox flex={1} style={{ minHeight: 0 }}>
            <TopicChatDrawerBody
              agentId={run.agentId}
              operationId={run.activity.operationId}
              defaultInputExpanded
              disableInputCollapse
              runningOperation={run.activity.runningOperation}
              topicId={run.activity.id!}
            />
          </Flexbox>
        </section>
      )}
    </div>
  );
};

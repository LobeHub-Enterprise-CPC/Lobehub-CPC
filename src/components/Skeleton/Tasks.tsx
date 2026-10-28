'use client';

import { Block, Divider, Flexbox } from '@lobehub/ui';
import { Fragment } from 'react';
import { useLocation } from 'react-router';

import TaskItemSkeleton from '@/features/AgentTasks/AgentTaskList/TaskItemSkeleton';
import NavHeader from '@/features/NavHeader';
import { isScheduledTasksWorkspace } from '@/features/NavPanel/isScheduledTasksWorkspace';
import WideScreenContainer from '@/features/WideScreenContainer';
import type { RouteSkeletonProps } from '@/spa/router/routeMeta';

import ScheduledTasksSkeleton from './ScheduledTasks';

const TasksSkeleton = ({ chrome = 'page' }: RouteSkeletonProps) => {
  const { pathname, search } = useLocation();
  if (isScheduledTasksWorkspace(pathname, search))
    return (
      <ScheduledTasksSkeleton showWelcome={!new URLSearchParams(search).has('scheduledTask')} />
    );
  return (
    <Flexbox aria-busy flex={1} height={'100%'}>
      {chrome !== 'body' && <NavHeader />}
      <WideScreenContainer
        fullWidth
        gap={16}
        paddingBlock={16}
        paddingInline={16}
        wrapperStyle={{ flex: 1, overflowY: 'auto' }}
      >
        <Block gap={2} padding={2} variant={'borderless'}>
          {Array.from({ length: 5 }).map((_, index) => (
            <Fragment key={index}>
              <TaskItemSkeleton />
              {index !== 4 && <Divider dashed />}
            </Fragment>
          ))}
        </Block>
      </WideScreenContainer>
    </Flexbox>
  );
};

export default TasksSkeleton;

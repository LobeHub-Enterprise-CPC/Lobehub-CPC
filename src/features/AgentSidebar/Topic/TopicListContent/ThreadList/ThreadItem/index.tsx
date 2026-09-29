import type { DragEvent } from 'react';
import { memo, useCallback } from 'react';

import { startThreadDrag } from '@/features/ChatInput/InputEditor/ReferTopic/threadDragData';
import ThreadNavItem from '@/features/NavPanel/components/ThreadNavItem';
import { useChatStore } from '@/store/chat';

import { useThreadNavigation } from '../../../hooks/useThreadNavigation';
import Actions from './Actions';
import { useThreadItemDropdownMenu } from './useDropdownMenu';

export interface ThreadItemProps {
  id: string;
  index: number;
  isSubagent?: boolean;
  sourceMessageId?: string;
  title: string;
}

const ThreadItem = memo<ThreadItemProps>(({ title, id, isSubagent, sourceMessageId }) => {
  const activeThreadId = useChatStore((s) => s.activeThreadId);

  const { navigateToThread, isInAgentSubRoute } = useThreadNavigation();

  const handleClick = useCallback(() => {
    navigateToThread(id);
  }, [id, navigateToThread]);

  const handleDragStart = useCallback(
    (event: DragEvent) => {
      startThreadDrag(event, { sourceMessageId, threadId: id, threadTitle: title });
    },
    [id, title, sourceMessageId],
  );

  const dropdownMenu = useThreadItemDropdownMenu({
    id,
    sourceMessageId,
    title,
  });

  const active = id === activeThreadId;

  return (
    <>
      <ThreadNavItem
        draggable
        actions={<Actions dropdownMenu={dropdownMenu} />}
        active={active && !isInAgentSubRoute}
        contextMenuItems={dropdownMenu}
        data-thread-id={id}
        nested={isSubagent}
        title={title}
        onClick={handleClick}
        onDragStart={handleDragStart}
      />
    </>
  );
});

export default ThreadItem;

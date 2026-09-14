import type { DragEvent } from 'react';
import { memo, useCallback } from 'react';

import { startThreadDrag } from '@/features/ChatInput/InputEditor/ReferTopic/threadDragData';
import ThreadNavItem from '@/features/NavPanel/components/ThreadNavItem';
import { useChatStore } from '@/store/chat';

import { useThreadNavigation } from '../../../hooks/useThreadNavigation';
import Actions from './Actions';
import Editing from './Editing';
import { useThreadItemDropdownMenu } from './useDropdownMenu';

export interface ThreadItemProps {
  id: string;
  index: number;
  isSubagent?: boolean;
  sourceMessageId?: string;
  title: string;
}

const ThreadItem = memo<ThreadItemProps>(({ title, id, isSubagent, sourceMessageId }) => {
  const [editing, activeThreadId] = useChatStore((s) => [
    s.threadRenamingId === id,
    s.activeThreadId,
  ]);

  const { navigateToThread, isInAgentSubRoute } = useThreadNavigation();

  const toggleEditing = useCallback(
    (visible?: boolean) => {
      useChatStore.setState({ threadRenamingId: visible ? id : '' });
    },
    [id],
  );

  const handleClick = useCallback(() => {
    if (editing) return;
    navigateToThread(id);
  }, [editing, id, navigateToThread]);

  const handleDragStart = useCallback(
    (event: DragEvent) => {
      startThreadDrag(event, { sourceMessageId, threadId: id, threadTitle: title });
    },
    [id, title, sourceMessageId],
  );

  const dropdownMenu = useThreadItemDropdownMenu({
    id,
    sourceMessageId,
    toggleEditing,
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
        disabled={editing}
        nested={isSubagent}
        title={title}
        onClick={handleClick}
        onDragStart={handleDragStart}
      />
      <Editing id={id} title={title} toggleEditing={toggleEditing} />
    </>
  );
});

export default ThreadItem;

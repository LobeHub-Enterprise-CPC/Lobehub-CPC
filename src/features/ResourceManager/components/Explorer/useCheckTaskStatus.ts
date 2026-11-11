import { useEffect } from 'react';

import { resourceService } from '@/services/resource';
import { getChunkTargetId, useFileStore } from '@/store/file';
import { AsyncTaskStatus } from '@/types/asyncTask';
import { type FileListItem } from '@/types/files';

/** Queued or running: the status will change without the user doing anything. */
const isActive = (status?: string | null) =>
  status === AsyncTaskStatus.Pending || status === AsyncTaskStatus.Processing;

export const useCheckTaskStatus = (data: FileListItem[] | undefined) => {
  const processingFileIds =
    data
      ?.filter(
        (item) =>
          item.sourceType === 'file' &&
          (isActive(item.chunkingStatus) || isActive(item.embeddingStatus)),
      )
      .map(getChunkTargetId) ?? [];
  const processingKey = processingFileIds.join(',');

  // Poll every 5s to check if chunking/embedding status has changed
  useEffect(() => {
    if (processingFileIds.length === 0) return;

    const interval = setInterval(() => {
      void resourceService
        .getResourceStatusesByIds(processingFileIds)
        .then((items) => {
          useFileStore.getState().patchLocalResourceStatuses(items);
        })
        .catch((error) => {
          console.error('Failed to sync knowledge item statuses:', error);
        });
    }, 5000);

    return () => {
      clearInterval(interval);
    };
  }, [processingKey]);
};

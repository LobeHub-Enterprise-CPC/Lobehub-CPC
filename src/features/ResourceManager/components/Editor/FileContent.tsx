'use client';

import { Flexbox } from '@lobehub/ui';
import { memo } from 'react';

import AsyncError from '@/components/AsyncError';
import { useLibraryPermission } from '@/features/EnterpriseKnowledge/useLibraryPermission';
import FileNotFound from '@/features/FileNotFound';
import FileViewer from '@/features/FileViewer';
import ImageEditTools from '@/features/FileViewer/ImageEditTools';
import { useFileStore } from '@/store/file';

interface FilePreviewerProps {
  fileId?: string;
  onClose?: () => void;
}

const FilePreviewer = memo<FilePreviewerProps>(({ fileId, onClose }) => {
  const { allowed } = useLibraryPermission('edit_own_content');
  const useFetchKnowledgeItem = useFileStore((s) => s.useFetchKnowledgeItem);
  const { data: displayFile, error, isLoading, mutate } = useFetchKnowledgeItem(fileId);
  if (error) return <AsyncError error={error} variant="page" onRetry={() => mutate()} />;
  if (fileId && !isLoading && !displayFile) return <FileNotFound />;

  if (!fileId || !displayFile) return null;

  return (
    <Flexbox height={'100%'} width={'100%'}>
      <Flexbox flex={1} height={'100%'} style={{ overflow: 'auto' }}>
        <FileViewer
          {...displayFile}
          imageTools={allowed ? <ImageEditTools /> : undefined}
          onClose={onClose}
        />
      </Flexbox>
    </Flexbox>
  );
});

FilePreviewer.displayName = 'FilePreviewer';

export default FilePreviewer;

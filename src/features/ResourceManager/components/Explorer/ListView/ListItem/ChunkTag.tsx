import { Button, Tag } from '@lobehub/ui';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import FileParsingStatusTag from '@/components/FileParsingStatus';
import { useLibraryPermission } from '@/features/EnterpriseKnowledge/useLibraryPermission';
import { fileManagerSelectors, useFileStore } from '@/store/file';
import { type FileParsingTask } from '@/types/asyncTask';

interface ChunkTagProps extends FileParsingTask {
  id: string;
}

const ChunksBadge = memo<ChunkTagProps>(({ id, ...res }) => {
  const { allowed: canEdit } = useLibraryPermission('edit_own_content');
  const [
    isCreatingChunkEmbeddingTask,
    embeddingChunks,
    reParseFile,
    openChunkDrawer,
    reEmbeddingChunks,
  ] = useFileStore((s) => [
    fileManagerSelectors.isCreatingChunkEmbeddingTask(id)(s),
    s.embeddingChunks,
    s.reParseFile,
    s.openChunkDrawer,
    s.reEmbeddingChunks,
  ]);

  const { t } = useTranslation('knowledgeBase');
  if (!canEdit)
    return (
      <Tag>
        {res.chunkingStatus === 'success' ? (
          <Button size="small" type="text" onClick={() => openChunkDrawer(id)}>
            {t('enterprise.chunks', { count: res.chunkCount ?? 0 })}
          </Button>
        ) : (
          t(
            res.chunkingStatus === 'error' || res.embeddingStatus === 'error'
              ? 'enterprise.failed'
              : 'enterprise.processing',
          )
        )}
      </Tag>
    );
  return (
    <FileParsingStatusTag
      preparingEmbedding={isCreatingChunkEmbeddingTask}
      onEmbeddingClick={canEdit ? () => embeddingChunks([id]) : undefined}
      onClick={(status) => {
        if (status === 'success') openChunkDrawer(id);
      }}
      onErrorClick={
        canEdit
          ? (task) => {
              if (task === 'chunking') reParseFile(id);
              if (task === 'embedding') reEmbeddingChunks(id);
            }
          : undefined
      }
      {...res}
    />
  );
});

export default ChunksBadge;

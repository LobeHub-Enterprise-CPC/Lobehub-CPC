import type { ChatFileItem } from '@lobechat/types';
import { createModal } from '@lobehub/ui/base-ui';

import FileListViewer from '@/features/Conversation/Messages/User/components/FileListViewer';
import FileViewer from '@/features/FileViewer';

/** Channel's right panel is a thread, so use the shared file viewer in a modal. */
export function MessageAttachments({ items }: { items: ChatFileItem[] }) {
  return (
    <FileListViewer
      items={items}
      onOpenFile={(file) =>
        createModal({
          title: file.name,
          footer: null,
          maskClosable: true,
          width: 'min(90vw, 1024px)',
          styles: { content: { height: '80vh', minHeight: 0, overflow: 'auto', padding: 0 } },
          content: (
            <FileViewer
              chunkCount={null}
              chunkingError={null}
              createdAt={new Date()}
              embeddingError={null}
              fileType={file.fileType}
              finishEmbedding={false}
              id={file.id}
              name={file.name}
              size={file.size}
              sourceType="upload"
              updatedAt={new Date()}
              url={file.url}
            />
          ),
        })
      }
    />
  );
}

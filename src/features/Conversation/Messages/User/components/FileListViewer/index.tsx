import { Flexbox } from '@lobehub/ui';
import { memo } from 'react';

import { type ChatFileItem } from '@/types/index';

import FileItem from './Item';

interface FileListViewerProps {
  items: ChatFileItem[];
  onOpenFile?: (file: ChatFileItem) => void;
}

const FileListViewer = memo<FileListViewerProps>(({ items, onOpenFile }) => {
  return (
    <Flexbox gap={8}>
      {items.map((item) => (
        <FileItem
          key={item.id}
          {...item}
          onClick={onOpenFile ? () => onOpenFile(item) : undefined}
        />
      ))}
    </Flexbox>
  );
});
export default FileListViewer;

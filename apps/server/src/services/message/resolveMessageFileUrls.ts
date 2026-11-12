import type { AssistantContentBlock, UIChatMessage } from '@lobechat/types';
import pMap from 'p-map';

interface MessageFile {
  id: string;
  inaccessible?: boolean;
  url: string;
}

/** Resolve attachments without mutating the shared DB snapshot or tool payloads. */
export const resolveMessageFileUrls = async (
  messages: UIChatMessage[],
  resolveUrl: (file: MessageFile) => Promise<string>,
): Promise<UIChatMessage[]> =>
  resolveMessageFileUrlsInBatch(messages, (files) => pMap(files, resolveUrl, { concurrency: 10 }));

/** Browser URL classification runs once across all messages and nested attachments. */
export const resolveMessageFileUrlsInBatch = async (
  messages: UIChatMessage[],
  resolveUrls: (files: MessageFile[]) => Promise<string[]>,
): Promise<UIChatMessage[]> => {
  const pendingFiles: MessageFile[] = [];
  const cloneFiles = <T extends MessageFile>(files: T[]) =>
    files.map((file) => {
      const cloned = { ...file };
      if (!cloned.inaccessible) pendingFiles.push(cloned);
      return cloned;
    });

  const cloneAttachments = <
    T extends Pick<UIChatMessage, 'audioList' | 'fileList' | 'imageList' | 'videoList'>,
  >(
    item: T,
  ) => ({
    ...item,
    ...(item.fileList && { fileList: cloneFiles(item.fileList) }),
    ...(item.imageList && { imageList: cloneFiles(item.imageList) }),
    ...(item.videoList && { videoList: cloneFiles(item.videoList) }),
    ...(item.audioList && { audioList: cloneFiles(item.audioList) }),
  });
  const cloneBlocks = (blocks: AssistantContentBlock[]) =>
    blocks.map((block) => ({
      ...cloneAttachments(block),
      ...(block.council && { council: cloneMessages(block.council) }),
    }));
  const cloneMessages = (list: UIChatMessage[]): UIChatMessage[] =>
    list.map((message) => ({
      ...cloneAttachments(message),
      ...(message.children && { children: cloneBlocks(message.children) }),
      ...(message.taskCompletions && { taskCompletions: cloneBlocks(message.taskCompletions) }),
      ...(message.tasks && { tasks: cloneMessages(message.tasks) }),
      ...(message.columns && { columns: message.columns.map(cloneMessages) }),
      ...(message.compressedMessages && {
        compressedMessages: cloneMessages(message.compressedMessages),
      }),
      ...(message.members && { members: cloneMessages(message.members) }),
    }));

  const resolved = cloneMessages(messages);
  if (pendingFiles.length === 0) return resolved;
  const urls = await resolveUrls(pendingFiles);
  pendingFiles.forEach((file, index) => {
    file.url = urls[index];
  });
  return resolved;
};

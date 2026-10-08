import type { UIChatMessage } from '@lobechat/types';

import type { LobeChatDatabase } from '@/database/type';

/** Refresh owner-authorized attachments for prompts/tools, never for durable session writes. */
export const hydrateChannelMessageAttachments = async (
  db: LobeChatDatabase,
  userId: string,
  messages: UIChatMessage[],
): Promise<UIChatMessage[]> =>
  Promise.all(
    messages.map(async (message) => {
      if (!message.files?.length) return message;
      const { resolveAttachmentsByFileIds } =
        await import('@/server/services/file/resolveAttachments');
      const attachments = await resolveAttachmentsByFileIds({
        db,
        fileIds: message.files,
        userId,
      });
      return {
        ...message,
        fileList: attachments.fileList,
        imageList: attachments.imageList,
        audioList: attachments.audioList,
        videoList: attachments.videoList,
        content: [message.content, ...attachments.warnings].filter(Boolean).join('\n\n'),
      };
    }),
  );

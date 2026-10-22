import type { UIChatMessage } from '@lobechat/types';

import { lambdaClient } from '@/libs/trpc/client';

/**
 * Visitor-facing, read-only APIs for shared agents, keyed by shareId and authorized server-side
 * against `topics.senderId`. Visitor runs, uploads, interventions and gateway tokens are closed.
 */
class ShareChatService {
  async getTopics(shareId: string) {
    return await lambdaClient.shareChat.getTopics.query({ shareId });
  }

  async getMessages(shareId: string, topicId: string): Promise<UIChatMessage[]> {
    // Mirrors the owner path's `includeFileWorks` opt-in (see messageService).
    const data = await lambdaClient.shareChat.getMessages.query({
      includeFileWorks: true,
      shareId,
      topicId,
    });
    return data as unknown as UIChatMessage[];
  }

  /**
   * A document the visitor's own share run produced — the open target of a
   * `document` Work card on the visitor surface. Resolved server-side under
   * the visitor's share scope, so any other document 404s.
   */
  async getDocument(shareId: string, topicId: string, documentId: string) {
    return await lambdaClient.shareChat.getDocument.query({ documentId, shareId, topicId });
  }
}

export const shareChatService = new ShareChatService();

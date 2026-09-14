import { randomUUID } from 'node:crypto';

import type { CompressionTransport } from '@lobechat/agent-runtime';
import { chainCompressContext } from '@lobechat/prompts';
import type { UIChatMessage } from '@lobechat/types';

import type { ChannelRuntimeModel } from '@/database/models/channelRuntime';

/** Native compression prompt/executor, with summaries and originals in the private session. */
export function createChannelCompressionTransport(
  store: ChannelRuntimeModel,
): CompressionTransport {
  const pending = new Map<string, UIChatMessage[]>();
  return {
    buildPrompt: async (input) => ({
      messages: chainCompressContext(input.messages, input.existingSummary).messages!,
    }),
    createGroup: async ({ messageIds }) => {
      const selected = (await store.messages()).filter((message) =>
        messageIds.includes(message.id),
      );
      const messageGroupId = `chn_compression_${randomUUID()}`;
      pending.set(messageGroupId, selected);
      return { messageGroupId, messagesToSummarize: selected };
    },
    finalizeGroup: async ({ messageGroupId, content, sourceGroupIds }) => {
      const selected = pending.get(messageGroupId);
      if (!selected) throw new Error('Unknown Channel compression attempt');
      const sources = (await store.messages()).filter((message) =>
        sourceGroupIds?.includes(message.id),
      );
      const originals = [...sources, ...selected];
      await store.createMessage(
        {
          id: messageGroupId,
          role: 'compressedGroup',
          content,
          compressedMessages: originals,
          createdAt: originals[0]?.createdAt ?? Date.now(),
          updatedAt: Date.now(),
        },
        messageGroupId,
      );
      pending.delete(messageGroupId);
      return { messages: await store.messages() };
    },
    rollbackGroup: async ({ messageGroupId }) => {
      pending.delete(messageGroupId);
      return { messages: await store.messages() };
    },
  };
}

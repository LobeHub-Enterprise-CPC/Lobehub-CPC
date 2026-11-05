import type { LobeChatDatabase } from '@lobechat/database';
import { topics } from '@lobechat/database/schemas';
import type { OpenAIChatMessage } from '@lobechat/model-runtime';
import type { ChatTopicMetadata } from '@lobechat/types';
import { and, eq } from 'drizzle-orm';
import { u } from 'unist-builder';
import { toXml } from 'xast-util-to-xml';
import type { Child } from 'xastscript';
import { x } from 'xastscript';

import type {
  BuiltContext,
  MemoryContextProvider,
  MemoryExtractionJob,
  MemoryResultRecorder,
  PersistedMemoryResult,
} from '../types';

type RunState = NonNullable<ChatTopicMetadata['userMemoryExtractRunState']>;

export interface ChatTopicProviderOptions {
  conversations: (OpenAIChatMessage & { createdAt: Date })[];
  /**
   * Conversation before the part being extracted, already extracted by an earlier run. Sent so
   * references in `conversations` make sense; marked so nothing in it is extracted again.
   */
  previousConversations?: (OpenAIChatMessage & { createdAt: Date })[];
  topic: {
    createdAt: Date;
    id: string;
    metadata?: ChatTopicMetadata | null;
    title?: string | null;
    updatedAt?: Date | null;
  };
  topicId: string;
}

export interface ChatTopicResultRecorderOptions {
  currentMetadata?: ChatTopicMetadata;
  database: LobeChatDatabase;
  /** Watermark a successful run moves to: creation time of the last message it extracted. */
  extractedThrough?: string;
  lastMessageAt?: string;
  messageCount?: number;
  /** Watermark before this run; a failed run keeps it so a retry resumes from the same place. */
  previousExtractedThrough?: string;
  topicId: string;
  traceId?: string;
}

export class LobeChatTopicContextProvider implements MemoryContextProvider<
  Record<string, unknown>,
  Record<string, unknown>
> {
  private readonly options: ChatTopicProviderOptions;

  constructor(options: ChatTopicProviderOptions) {
    this.options = options;
  }

  async buildContext(userId: string): Promise<BuiltContext> {
    const messageChildren = this.options.conversations.map(toMessageNode);
    const previousChildren = (this.options.previousConversations ?? []).map(toMessageNode);

    const lastMessageAt =
      this.options.conversations.at(-1)?.createdAt ?? this.options.topic.updatedAt;

    const metadataContent = this.options.topic.metadata
      ? JSON.stringify(this.options.topic.metadata)
      : '';

    const topicChildren: Child[] = [
      x('topic_metadata', metadataContent),
      ...(previousChildren.length > 0
        ? [
            x(
              'previous_messages',
              {
                count: previousChildren.length.toString(),
                note: 'Earlier part of this conversation, already processed. Use it only to understand the messages below; do not extract memories from it.',
              },
              ...previousChildren,
            ),
          ]
        : []),
      x('messages', { count: messageChildren.length.toString() }, ...messageChildren),
    ];

    if (this.options.topic.title) {
      topicChildren.unshift(x('topic_title', this.options.topic.title));
    }

    const topicAttributes: Record<string, string> = {
      created_at: new Date(this.options.topic.createdAt).toISOString(),
      id: this.options.topicId,
      message_count: messageChildren.length.toString(),
    };

    if (lastMessageAt) {
      topicAttributes.last_message_at = new Date(lastMessageAt).toISOString();
    }
    if (this.options.topic.updatedAt) {
      topicAttributes.updated_at = new Date(this.options.topic.updatedAt).toISOString();
    }

    const topicContext = toXml(u('root', [x('chat_topic', topicAttributes, ...topicChildren)]));

    return {
      context: topicContext,
      metadata: {},
      sourceId: this.options.topicId,
      userId,
    } satisfies BuiltContext;
  }
}

const toMessageNode = (message: OpenAIChatMessage & { createdAt: Date }, index: number): Child => {
  const attributes: Record<string, string> = {
    index: index.toString(),
    role: message.role ?? 'assistant',
  };

  if (message.createdAt) {
    attributes.created_at = new Date(message.createdAt).toISOString();
  }

  const content = Array.isArray(message.content)
    ? message.content
        .map((part) => {
          if (part.type === 'text') {
            return part.text;
          }
          if (part.type === 'thinking') {
            return `[Thinking: ${part.thinking}]`;
          }
          if (part.type === 'image_url') {
            return `[Image: ${part.image_url.url}]`;
          }
          if (part.type === 'video_url') {
            return `[Video: ${part.video_url.url}]`;
          }
          return '';
        })
        .join('\n')
    : message.content;

  return x('message', attributes, content);
};

export class LobeChatTopicResultRecorder implements MemoryResultRecorder<{
  processedMemoryCount: number;
}> {
  private readonly options: ChatTopicResultRecorderOptions;

  constructor(options: ChatTopicResultRecorderOptions) {
    this.options = options;
  }

  async recordComplete(
    job: MemoryExtractionJob,
    result: PersistedMemoryResult & { processedMemoryCount: number },
  ): Promise<void> {
    const existingMetadata = (this.options.currentMetadata as ChatTopicMetadata | undefined) ?? {};

    const now = new Date().toISOString();
    const memoryExtraction: RunState = existingMetadata.userMemoryExtractRunState ?? {
      error: undefined,
      lastMessageAt: this.options.lastMessageAt,
      lastRunAt: now,
      messageCount: this.options.messageCount,
      processedMemoryCount: result.processedMemoryCount,
      traceId: this.options.traceId,
    };

    memoryExtraction.extractedThrough = this.options.extractedThrough;
    memoryExtraction.lastMessageAt = this.options.lastMessageAt;
    memoryExtraction.lastRunAt = now;
    memoryExtraction.messageCount = this.options.messageCount;
    memoryExtraction.processedMemoryCount = result.processedMemoryCount;
    memoryExtraction.traceId = this.options.traceId;

    const updatedMetadata: ChatTopicMetadata = {
      ...existingMetadata,
      userMemoryExtractRunState: memoryExtraction,
      userMemoryExtractStatus: 'completed',
    };

    await this.options.database
      .update(topics)
      .set({ metadata: updatedMetadata, updatedAt: topics.updatedAt })
      .where(and(eq(topics.id, this.options.topicId), eq(topics.userId, job.userId)));
  }

  async recordFail(job: MemoryExtractionJob, error: Error): Promise<void> {
    const existingMetadata = (this.options.currentMetadata as ChatTopicMetadata | undefined) ?? {};

    const now = new Date().toISOString();
    const memoryExtraction: RunState = existingMetadata.userMemoryExtractRunState ?? {
      error: error.message,
      lastMessageAt: this.options.lastMessageAt,
      lastRunAt: now,
      messageCount: this.options.messageCount,
      processedMemoryCount: 0,
      traceId: this.options.traceId,
    };

    memoryExtraction.error = error.message;
    memoryExtraction.extractedThrough = this.options.previousExtractedThrough;
    memoryExtraction.lastMessageAt = this.options.lastMessageAt;
    memoryExtraction.lastRunAt = now;
    memoryExtraction.messageCount = this.options.messageCount;
    memoryExtraction.processedMemoryCount = 0;
    memoryExtraction.traceId = this.options.traceId;

    const updatedMetadata: ChatTopicMetadata = {
      ...existingMetadata,
      userMemoryExtractRunState: memoryExtraction,
      userMemoryExtractStatus: 'failed',
    };

    await this.options.database
      .update(topics)
      .set({ metadata: updatedMetadata, updatedAt: topics.updatedAt })
      .where(and(eq(topics.id, this.options.topicId), eq(topics.userId, job.userId)));
  }
}

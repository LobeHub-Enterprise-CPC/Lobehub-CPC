import type { LobeChatDatabase } from '@lobechat/database';
import { topics } from '@lobechat/database/schemas';
import type { OpenAIChatMessage } from '@lobechat/model-runtime';
import type { ChatTopicMetadata } from '@lobechat/types';
import { and, eq, sql } from 'drizzle-orm';
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

/** Where a topic's extraction watermark lives in `topics.metadata`. */
const WATERMARK_PATH = sql.raw(`'{userMemoryExtractRunState,extractedThrough}'::text[]`);
/**
 * The stored progress, as `readWatermark` reads it: the explicit watermark, or for a topic
 * completed before the watermark existed, the last message its run saw.
 */
const storedWatermark = sql`coalesce(
  ${topics.metadata} #> ${WATERMARK_PATH},
  case when ${topics.metadata} ->> 'userMemoryExtractStatus' = 'completed'
    then ${topics.metadata} #> '{userMemoryExtractRunState,lastMessageAt}'::text[] end
)`;

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

  /** `database` lets the watermark commit in the transaction that wrote the memories. */
  async recordComplete(
    job: MemoryExtractionJob,
    result: PersistedMemoryResult & { processedMemoryCount: number },
    database: LobeChatDatabase = this.options.database,
  ): Promise<void> {
    const existingMetadata = (this.options.currentMetadata as ChatTopicMetadata | undefined) ?? {};

    const now = new Date().toISOString();
    // A copy: the snapshot must survive a rolled-back transaction for `recordFail`.
    const memoryExtraction: RunState = { ...existingMetadata.userMemoryExtractRunState };

    // An earlier failed run left its error and count behind; a completed topic has neither.
    delete memoryExtraction.error;
    delete memoryExtraction.failedRuns;
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

    const updated = await database
      .update(topics)
      .set({ metadata: updatedMetadata, updatedAt: topics.updatedAt })
      .where(and(eq(topics.id, this.options.topicId), eq(topics.userId, job.userId)))
      .returning({ id: topics.id });
    // No watermark moved (topic deleted or not this user's): the memories must not commit alone.
    if (updated.length !== 1) {
      throw new Error(`Memory extraction watermark not recorded for topic ${this.options.topicId}`);
    }
  }

  async recordFail(job: MemoryExtractionJob, error: Error): Promise<void> {
    const existingMetadata = (this.options.currentMetadata as ChatTopicMetadata | undefined) ?? {};

    const now = new Date().toISOString();
    const memoryExtraction: RunState = { ...existingMetadata.userMemoryExtractRunState };

    // Count failures on the same conversation; new messages since the last run start it over.
    const previousRunAt = existingMetadata.userMemoryExtractRunState?.lastRunAt;
    const conversationMoved =
      !!previousRunAt &&
      !!this.options.lastMessageAt &&
      new Date(this.options.lastMessageAt) > new Date(previousRunAt);
    memoryExtraction.failedRuns = conversationMoved ? 1 : (memoryExtraction.failedRuns ?? 0) + 1;
    memoryExtraction.error = error.message;
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

    // The watermark stays as stored (computed from the row, not this run's snapshot): a run that
    // failed did not move it, one whose commit went through before the error must not be moved
    // back, and a topic completed before the watermark existed keeps its progress explicitly
    // once its status turns `failed`.
    await this.options.database
      .update(topics)
      .set({
        metadata: sql`case
          when ${storedWatermark} is null then ${JSON.stringify(updatedMetadata)}::jsonb #- ${WATERMARK_PATH}
          else jsonb_set(${JSON.stringify(updatedMetadata)}::jsonb, ${WATERMARK_PATH}, ${storedWatermark})
        end`,
        updatedAt: topics.updatedAt,
      })
      .where(and(eq(topics.id, this.options.topicId), eq(topics.userId, job.userId)));
  }
}

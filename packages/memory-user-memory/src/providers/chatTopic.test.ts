import { MemorySourceType } from '@lobechat/types';
import { describe, expect, it, vi } from 'vitest';

import type { ChatTopicResultRecorderOptions } from './chatTopic';
import { LobeChatTopicContextProvider, LobeChatTopicResultRecorder } from './chatTopic';

const job = {
  source: MemorySourceType.ChatTopic,
  sourceId: 'topic-1',
  userId: 'user-1',
};

describe('LobeChatTopicContextProvider', () => {
  it('should build XML topic context with messages and metadata', async () => {
    const provider = new LobeChatTopicContextProvider({
      conversations: [
        {
          content: 'Hello',
          createdAt: new Date('2024-03-01T10:00:00.000Z'),
          role: 'user',
        },
        {
          content: 'Hi there',
          createdAt: new Date('2024-03-01T10:01:00.000Z'),
          role: 'assistant',
        },
      ],
      topic: {
        createdAt: new Date('2024-03-01T09:00:00.000Z'),
        id: 'topic-1',
        metadata: { userMemoryExtractStatus: 'pending' },
        title: 'Daily chat',
        updatedAt: new Date('2024-03-01T10:02:00.000Z'),
      },
      topicId: 'topic-1',
    });

    const result = await provider.buildContext(job.userId);

    expect(result.context).toContain(
      '<chat_topic created_at="2024-03-01T09:00:00.000Z" id="topic-1" message_count="2" last_message_at="2024-03-01T10:01:00.000Z" updated_at="2024-03-01T10:02:00.000Z">',
    );
    expect(result.context).toContain('<topic_title>Daily chat</topic_title>');
    expect(result.context).toContain(
      '<topic_metadata>{"userMemoryExtractStatus":"pending"}</topic_metadata>',
    );
    expect(result.context).toContain(
      '<messages count="2"><message index="0" role="user" created_at="2024-03-01T10:00:00.000Z">Hello</message><message index="1" role="assistant" created_at="2024-03-01T10:01:00.000Z">Hi there</message></messages>',
    );
    expect(result.sourceId).toBe('topic-1');
    expect(result.userId).toBe('user-1');
  });
});

describe('LobeChatTopicContextProvider previous conversation', () => {
  it('sends earlier turns apart from the turns to extract, marked as already processed', async () => {
    const provider = new LobeChatTopicContextProvider({
      conversations: [
        { content: 'New question', createdAt: new Date('2024-03-02T10:00:00.000Z'), role: 'user' },
      ],
      previousConversations: [
        {
          content: 'Earlier answer',
          createdAt: new Date('2024-03-01T10:00:00.000Z'),
          role: 'assistant',
        },
      ],
      topic: { createdAt: new Date('2024-03-01T09:00:00.000Z'), id: 'topic-1' },
      topicId: 'topic-1',
    });

    const { context } = await provider.buildContext(job.userId);

    const previous = context.slice(
      context.indexOf('<previous_messages'),
      context.indexOf('</previous_messages>'),
    );
    const current = context.slice(context.indexOf('<messages'), context.indexOf('</messages>'));
    expect(previous).toContain('already processed');
    expect(previous).toContain('Earlier answer');
    expect(current).toContain('New question');
    expect(current).not.toContain('Earlier answer');
    expect(context).toContain('message_count="1"');
  });
});

describe('LobeChatTopicResultRecorder watermark', () => {
  const recorderWith = (options: Partial<ChatTopicResultRecorderOptions>) => {
    const set = vi.fn(() => ({ where: vi.fn() }));
    const recorder = new LobeChatTopicResultRecorder({
      // Completed before the watermark existed: only lastMessageAt marks how far it got.
      currentMetadata: {
        userMemoryExtractRunState: { lastMessageAt: options.previousExtractedThrough },
        userMemoryExtractStatus: 'completed',
      },
      database: { update: () => ({ set }) } as any,
      topicId: 'topic-1',
      ...options,
    });
    const written = () => (set.mock.calls[0] as any)[0].metadata.userMemoryExtractRunState;
    return { recorder, written };
  };

  it('moves the watermark to the last extracted message on success', async () => {
    const { recorder, written } = recorderWith({
      extractedThrough: '2024-03-02T10:00:00.000Z',
      previousExtractedThrough: '2024-03-01T10:00:00.000Z',
    });

    await recorder.recordComplete(job, {
      createdIds: [],
      layers: {},
      processedMemoryCount: 0,
    } as any);

    expect(written().extractedThrough).toBe('2024-03-02T10:00:00.000Z');
  });

  it('keeps the watermark where it was when the run fails, so a retry resumes there', async () => {
    const { recorder, written } = recorderWith({
      extractedThrough: '2024-03-02T10:00:00.000Z',
      previousExtractedThrough: '2024-03-01T10:00:00.000Z',
    });

    await recorder.recordFail(job, new Error('model returned invalid output'));

    expect(written().extractedThrough).toBe('2024-03-01T10:00:00.000Z');
  });

  it('counts consecutive failed runs on a conversation that has not moved', async () => {
    const { recorder, written } = recorderWith({
      currentMetadata: {
        userMemoryExtractRunState: {
          failedRuns: 2,
          lastMessageAt: '2024-03-01T09:00:00.000Z',
          lastRunAt: '2024-03-01T12:00:00.000Z',
        },
        userMemoryExtractStatus: 'failed',
      },
      lastMessageAt: '2024-03-01T09:00:00.000Z',
    });

    await recorder.recordFail(job, new Error('504 Gateway Time-out'));

    expect(written().failedRuns).toBe(3);
  });

  it('starts the failure count over when new conversation arrived since the last run', async () => {
    const { recorder, written } = recorderWith({
      currentMetadata: {
        userMemoryExtractRunState: { failedRuns: 4, lastRunAt: '2024-03-01T12:00:00.000Z' },
        userMemoryExtractStatus: 'failed',
      },
      lastMessageAt: '2024-03-02T08:00:00.000Z',
    });

    await recorder.recordFail(job, new Error('504 Gateway Time-out'));

    expect(written().failedRuns).toBe(1);
  });

  it('drops the failure count once a run succeeds', async () => {
    const { recorder, written } = recorderWith({
      currentMetadata: {
        userMemoryExtractRunState: { failedRuns: 2 },
        userMemoryExtractStatus: 'failed',
      },
    });

    await recorder.recordComplete(job, {
      createdIds: [],
      layers: {},
      processedMemoryCount: 0,
    } as any);

    expect(written()).not.toHaveProperty('failedRuns');
  });

  it('clears the error of an earlier failed run once a run succeeds', async () => {
    const set = vi.fn(() => ({ where: vi.fn() }));
    const recorder = new LobeChatTopicResultRecorder({
      currentMetadata: {
        userMemoryExtractRunState: { error: 'model returned invalid output' },
        userMemoryExtractStatus: 'failed',
      },
      database: { update: () => ({ set }) } as any,
      topicId: 'topic-1',
    });

    await recorder.recordComplete(job, {
      createdIds: [],
      layers: {},
      processedMemoryCount: 2,
    } as any);

    const { metadata } = (set.mock.calls[0] as any)[0];
    expect(metadata.userMemoryExtractStatus).toBe('completed');
    expect(metadata.userMemoryExtractRunState).not.toHaveProperty('error');
  });
});

import { RequestTrigger, ThreadStatus, ThreadType } from '@lobechat/types';
import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '../../core/getTestDB';
import {
  agentOperations,
  messages,
  sessions,
  threads,
  topics,
  users,
  workspaces,
} from '../../schemas';
import type { LobeChatDatabase } from '../../type';
import { ThreadModel } from '../thread';

const userId = 'thread-user-test';
const otherUserId = 'other-user-test';
const sessionId = 'thread-session';
const topicId = 'thread-topic';

const serverDB: LobeChatDatabase = await getTestDB();
const threadModel = new ThreadModel(serverDB, userId);

describe('ThreadModel', () => {
  beforeEach(async () => {
    await serverDB.delete(users);

    // Create test users, session and topic
    await serverDB.transaction(async (tx) => {
      await tx.insert(users).values([{ id: userId }, { id: otherUserId }]);
      await tx.insert(sessions).values({ id: sessionId, userId });
      await tx.insert(topics).values({ id: topicId, userId, sessionId });
    });
  });

  afterEach(async () => {
    await serverDB.delete(users);
  });

  describe('run callback conditional writes', () => {
    const metadata = {
      runToken: 'token',
      operationId: 'old-op',
      startedAt: '2026-10-30T00:00:00Z',
      totalTokens: 10,
    };
    const createRun = () =>
      threadModel.create({
        topicId,
        type: ThreadType.Standalone,
        status: ThreadStatus.Processing,
        metadata,
      });

    it('accepts only increasing progress per operation and preserves metadata', async () => {
      const thread = await createRun();
      expect(
        await threadModel.updateProgressForRun(thread.id, 'token', 'run', 0, { totalTokens: 20 }),
      ).toBe(true);
      expect(
        await threadModel.updateProgressForRun(thread.id, 'token', 'run', 0, { totalTokens: 1 }),
      ).toBe(false);
      expect(await threadModel.updateProgressForRun(thread.id, 'wrong-token', 'run', 5, {})).toBe(
        false,
      );
      expect(
        await threadModel.updateProgressForRun(thread.id, 'token', 'run', 5, { totalTokens: 30 }),
      ).toBe(true);
      expect(
        await threadModel.updateProgressForRun(thread.id, 'token', 'resume', 0, {
          totalTokens: 40,
        }),
      ).toBe(true);
      expect((await threadModel.findById(thread.id))?.metadata).toMatchObject({
        runToken: 'token',
        operationId: 'resume',
        progressOperationId: 'resume',
        progressStep: 0,
        totalTokens: 40,
      });
    });

    it.each([undefined, null, '', 'previous-operation'])(
      'accepts initial progress with a previous operation marker of %s',
      async (progressOperationId) => {
        const thread = await threadModel.create({
          topicId,
          type: ThreadType.Standalone,
          status: ThreadStatus.Processing,
          metadata,
        });
        // Historical JSON can contain null even though current writers omit this field.
        await serverDB
          .update(threads)
          .set({
            metadata: sql`${JSON.stringify({ ...metadata, progressOperationId, progressStep: 99 })}::jsonb`,
          })
          .where(eq(threads.id, thread.id));
        expect(await threadModel.updateProgressForRun(thread.id, 'token', 'run', 0, {})).toBe(true);
        expect(await threadModel.updateProgressForRun(thread.id, 'token', 'run', 0, {})).toBe(
          false,
        );
      },
    );

    it('completes once and rejects late progress and duplicate completion', async () => {
      const thread = await createRun();
      expect(
        await threadModel.completeRun(thread.id, 'token', 'run', ThreadStatus.Completed, {
          completedAt: 'first',
          duration: 1,
        }),
      ).toBe(true);
      expect(
        await threadModel.completeRun(thread.id, 'token', 'run', ThreadStatus.Failed, {
          completedAt: 'second',
          duration: 2,
        }),
      ).toBe(false);
      expect(await threadModel.updateProgressForRun(thread.id, 'token', 'run', 9, {})).toBe(false);
      expect(await threadModel.findById(thread.id)).toMatchObject({
        status: ThreadStatus.Completed,
        metadata: {
          ...metadata,
          operationId: 'run',
          completedOperationId: 'run',
          completedAt: 'first',
          duration: 1,
        },
      });
    });

    it('keeps human waiting resumable under the same id and rejects late waiting', async () => {
      const thread = await createRun();
      expect(
        await threadModel.completeRun(thread.id, 'token', 'same-op', ThreadStatus.InReview, {}),
      ).toBe(true);
      expect(
        (await threadModel.findById(thread.id))?.metadata?.completedOperationId,
      ).toBeUndefined();
      expect(
        await threadModel.completeRun(thread.id, 'token', 'same-op', ThreadStatus.Completed, {
          totalTokens: 42,
        }),
      ).toBe(true);
      expect(
        await threadModel.completeRun(thread.id, 'token', 'same-op', ThreadStatus.InReview, {
          totalTokens: 1,
        }),
      ).toBe(false);
      expect((await threadModel.findById(thread.id))?.metadata?.totalTokens).toBe(42);
    });

    it('does not rotate or reset progress for a duplicate approval generation', async () => {
      const thread = await createRun();
      expect(await threadModel.setRunToken(thread.id, 'continuation-token', 'old-op')).toBe(true);
      await threadModel.updateProgressForRun(thread.id, 'continuation-token', 'continued', 4, {});
      expect(await threadModel.setRunToken(thread.id, 'continuation-token', 'old-op')).toBe(true);
      expect(await threadModel.setRunToken(thread.id, 'other-token', 'old-op')).toBe(false);
      expect((await threadModel.findById(thread.id))?.metadata).toMatchObject({
        runToken: 'continuation-token',
        progressStep: 4,
        operationId: 'continued',
      });
    });

    it('allows approval continuation from inReview and rejects the retired token', async () => {
      const thread = await createRun();
      expect(
        await threadModel.completeRun(thread.id, 'token', 'paused', ThreadStatus.InReview, {}),
      ).toBe(true);
      expect(
        await threadModel.completeRun(thread.id, 'token', 'paused', ThreadStatus.InReview, {
          duration: 999,
        }),
      ).toBe(false);
      expect(
        await threadModel.completeRun(thread.id, 'token', 'continued', ThreadStatus.InReview, {}),
      ).toBe(true);
      await threadModel.updateProgressForRun(thread.id, 'token', 'continued', 5, {});
      expect(await threadModel.setRunToken(thread.id, 'new-token', 'continued')).toBe(true);
      const renewed = await threadModel.findById(thread.id);
      expect(renewed?.status).toBe(ThreadStatus.InReview);
      expect(renewed?.metadata?.runToken).toBe('new-token');
      expect(renewed?.metadata).not.toHaveProperty('progressStep');
      expect(renewed?.metadata).not.toHaveProperty('progressOperationId');
      expect(await threadModel.updateProgressForRun(thread.id, 'token', 'continued', 6, {})).toBe(
        false,
      );
      expect(
        await threadModel.completeRun(thread.id, 'token', 'continued', ThreadStatus.Completed, {}),
      ).toBe(false);
      expect(await threadModel.updateProgressForRun(thread.id, 'new-token', 'resumed', 0, {})).toBe(
        true,
      );
      expect(
        await threadModel.completeRun(
          thread.id,
          'new-token',
          'resumed',
          ThreadStatus.Completed,
          {},
        ),
      ).toBe(true);
    });

    it('links an operation after completion without replacing final metadata', async () => {
      const thread = await createRun();
      await threadModel.completeRun(thread.id, 'token', 'run', ThreadStatus.Completed, {
        completedAt: 'first',
        duration: 12,
        totalTokens: 40,
      });
      expect(await threadModel.linkRunOperation(thread.id, 'token', 'run')).toBe(true);
      expect(await threadModel.findById(thread.id)).toMatchObject({
        status: ThreadStatus.Completed,
        metadata: {
          runToken: 'token',
          operationId: 'run',
          completedAt: 'first',
          duration: 12,
          totalTokens: 40,
        },
      });
      expect(await threadModel.linkRunOperation(thread.id, 'retired', 'wrong')).toBe(false);
      expect(await threadModel.failRun(thread.id, 'retired', { error: 'stale' })).toBe(false);
      expect(await threadModel.failRun(thread.id, 'token', { error: 'late failure' })).toBe(false);
    });

    it('merges startup failure metadata and retains the token', async () => {
      const thread = await createRun();
      expect(await threadModel.failRun(thread.id, 'retired', { error: 'stale failure' })).toBe(
        false,
      );
      expect(await threadModel.failRun(thread.id, 'token', { error: 'startup failed' })).toBe(true);
      expect(await threadModel.findById(thread.id)).toMatchObject({
        status: ThreadStatus.Failed,
        metadata: { ...metadata, error: 'startup failed' },
      });
    });

    it('rolls completion back when the summary transaction fails', async () => {
      const thread = await createRun();
      await expect(
        serverDB.transaction(async (tx) => {
          await new ThreadModel(tx, userId).completeRun(
            thread.id,
            'token',
            'run',
            ThreadStatus.Completed,
            {},
          );
          throw new Error('summary unavailable');
        }),
      ).rejects.toThrow('summary unavailable');
      expect(await threadModel.findById(thread.id)).toMatchObject({
        status: ThreadStatus.Processing,
        metadata,
      });
    });

    it('enforces user and workspace ownership on callback and token writes', async () => {
      const thread = await createRun();
      const other = new ThreadModel(serverDB, otherUserId);
      expect(await other.updateProgressForRun(thread.id, 'token', 'run', 1, {})).toBe(false);
      expect(await other.completeRun(thread.id, 'token', 'run', ThreadStatus.Completed, {})).toBe(
        false,
      );
      expect(await other.linkRunOperation(thread.id, 'token', 'run')).toBe(false);
      expect(await other.failRun(thread.id, 'token', {})).toBe(false);
      expect(await other.setRunToken(thread.id, 'new', 'old-op')).toBe(false);
      await serverDB.insert(workspaces).values({
        id: 'callback-workspace',
        primaryOwnerId: userId,
        slug: 'callback-workspace',
        name: 'Callback',
      });
      const scoped = new ThreadModel(serverDB, userId, 'callback-workspace');
      const workspaceThread = await scoped.create({
        topicId,
        type: ThreadType.Standalone,
        status: ThreadStatus.Processing,
        metadata,
      });
      expect(
        await threadModel.updateProgressForRun(workspaceThread.id, 'token', 'run', 1, {}),
      ).toBe(false);
      expect(
        await threadModel.completeRun(
          workspaceThread.id,
          'token',
          'run',
          ThreadStatus.Completed,
          {},
        ),
      ).toBe(false);
      expect(await scoped.updateProgressForRun(workspaceThread.id, 'token', 'run', 1, {})).toBe(
        true,
      );
      expect(
        await scoped.completeRun(workspaceThread.id, 'token', 'run', ThreadStatus.Completed, {}),
      ).toBe(true);
    });
  });

  describe('create', () => {
    it('should create a new thread', async () => {
      const result = await threadModel.create({
        topicId,
        type: ThreadType.Standalone,
        sourceMessageId: 'msg-1',
      });

      expect(result).toBeDefined();
      expect(result.topicId).toBe(topicId);
      expect(result.type).toBe(ThreadType.Standalone);
      expect(result.status).toBe(ThreadStatus.Active);
      expect(result.sourceMessageId).toBe('msg-1');
    });

    it('should create a thread with title', async () => {
      const result = await threadModel.create({
        topicId,
        type: ThreadType.Continuation,
        title: 'Test Thread',
      });

      expect(result.title).toBe('Test Thread');
      expect(result.type).toBe(ThreadType.Continuation);
    });

    it('should honor caller-provided id', async () => {
      const customId = 'thd_custom_abc';
      const result = await threadModel.create({
        id: customId,
        topicId,
        type: ThreadType.Standalone,
      });

      expect(result.id).toBe(customId);
    });

    it('should return undefined when caller-provided id collides (onConflictDoNothing)', async () => {
      const customId = 'thd_collide_xyz';
      const first = await threadModel.create({
        id: customId,
        topicId,
        type: ThreadType.Standalone,
      });
      expect(first.id).toBe(customId);

      // The router layer translates this undefined into TRPCError(CONFLICT)
      // so callers using client-provided ids see an explicit error instead
      // of writing follow-up rows against a missing thread.
      const second = await threadModel.create({
        id: customId,
        topicId,
        type: ThreadType.Standalone,
      });
      expect(second).toBeUndefined();
    });
  });

  describe('query', () => {
    it('should return all threads for the user', async () => {
      // Create test threads
      await serverDB.insert(threads).values([
        {
          id: 'thread-1',
          topicId,
          type: ThreadType.Standalone,
          status: ThreadStatus.Active,
          userId,
          updatedAt: new Date('2024-01-01'),
        },
        {
          id: 'thread-2',
          topicId,
          type: ThreadType.Continuation,
          status: ThreadStatus.Active,
          userId,
          updatedAt: new Date('2024-01-02'),
        },
      ]);

      const result = await threadModel.query();

      expect(result).toHaveLength(2);
      // Should be ordered by updatedAt desc
      expect(result[0].id).toBe('thread-2');
      expect(result[1].id).toBe('thread-1');
    });

    it('should only return threads for the current user', async () => {
      await serverDB.transaction(async (tx) => {
        await tx.insert(topics).values({ id: 'other-topic', userId: otherUserId });
        await tx.insert(threads).values([
          {
            id: 'thread-1',
            topicId,
            type: ThreadType.Standalone,
            status: ThreadStatus.Active,
            userId,
          },
          {
            id: 'thread-2',
            topicId: 'other-topic',
            type: ThreadType.Standalone,
            status: ThreadStatus.Active,
            userId: otherUserId,
          },
        ]);
      });

      const result = await threadModel.query();

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('thread-1');
    });
  });

  describe('queryByTopicId', () => {
    it('should return threads for a specific topic', async () => {
      await serverDB.transaction(async (tx) => {
        await tx.insert(topics).values({ id: 'another-topic', userId, sessionId });
        await tx.insert(threads).values([
          {
            id: 'thread-1',
            topicId,
            type: ThreadType.Standalone,
            status: ThreadStatus.Active,
            userId,
            updatedAt: new Date('2024-01-01'),
          },
          {
            id: 'thread-2',
            topicId: 'another-topic',
            type: ThreadType.Standalone,
            status: ThreadStatus.Active,
            userId,
            updatedAt: new Date('2024-01-02'),
          },
        ]);
      });

      const result = await threadModel.queryByTopicId(topicId);

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('thread-1');
    });

    it('should return empty array when no threads exist for the topic', async () => {
      const result = await threadModel.queryByTopicId('non-existent-topic');

      expect(result).toHaveLength(0);
    });

    it('derives subagent metrics (SUM tokens, COUNT tools, model) from child messages', async () => {
      await serverDB.transaction(async (tx) => {
        await tx.insert(threads).values({
          id: 'sub-thread',
          metadata: { sourceToolCallId: 'tc-1' },
          status: ThreadStatus.Active,
          topicId,
          type: ThreadType.Standalone,
          userId,
        });
        await tx.insert(messages).values([
          // two assistant turns → tokens SUM to 1000 + 1800 = 2800
          {
            id: 'm-a1',
            model: 'claude-opus-4-8',
            role: 'assistant',
            threadId: 'sub-thread',
            topicId,
            usage: { totalTokens: 1000 },
            userId,
          },
          { id: 'm-t1', role: 'tool', threadId: 'sub-thread', topicId, userId },
          // legacy row: usage only under metadata.usage (no promoted column)
          {
            id: 'm-a2',
            metadata: { usage: { totalTokens: 1800 } },
            role: 'assistant',
            threadId: 'sub-thread',
            topicId,
            userId,
          },
          { id: 'm-t2', role: 'tool', threadId: 'sub-thread', topicId, userId },
        ]);
      });

      const [thread] = await threadModel.queryByTopicId(topicId);

      expect(thread.id).toBe('sub-thread');
      expect(thread.metadata?.totalTokens).toBe(2800);
      expect(thread.metadata?.totalToolCalls).toBe(2);
      expect(thread.metadata?.model).toBe('claude-opus-4-8');
      // create-time metadata preserved
      expect(thread.metadata?.sourceToolCallId).toBe('tc-1');
    });

    it('omits derived metrics for a thread with no child messages', async () => {
      await serverDB.insert(threads).values({
        id: 'empty-thread',
        status: ThreadStatus.Active,
        topicId,
        type: ThreadType.Standalone,
        userId,
      });

      const [thread] = await threadModel.queryByTopicId(topicId);

      expect(thread.id).toBe('empty-thread');
      expect(thread.metadata?.totalTokens).toBeUndefined();
      expect(thread.metadata?.totalToolCalls).toBeUndefined();
      expect(thread.metadata?.model).toBeUndefined();
    });

    it('hides agent-signal isolation threads from topic thread lists', async () => {
      await serverDB.transaction(async (tx) => {
        await tx.insert(threads).values([
          {
            id: 'visible-subagent-thread',
            status: ThreadStatus.Active,
            title: 'Visible subagent',
            topicId,
            type: ThreadType.Isolation,
            userId,
          },
          {
            id: 'agent-signal-thread',
            status: ThreadStatus.Active,
            title: 'Agent Signal Skill',
            topicId,
            type: ThreadType.Isolation,
            userId,
          },
        ]);
        await tx.insert(agentOperations).values({
          id: 'agent-signal-operation',
          status: 'done',
          threadId: 'agent-signal-thread',
          topicId,
          trigger: RequestTrigger.AgentSignal,
          userId,
        });
      });

      const result = await threadModel.queryByTopicId(topicId);

      expect(result.map((thread) => thread.id)).toEqual(['visible-subagent-thread']);
    });

    it('hides marked onboarding Understanding writing threads from topic thread lists', async () => {
      await serverDB.insert(threads).values({
        id: 'understanding-thread',
        metadata: { onboardingUnderstanding: { kind: 'writing' } },
        status: ThreadStatus.Pending,
        topicId,
        type: ThreadType.Isolation,
        userId,
      });

      expect(await threadModel.queryByTopicId(topicId)).toEqual([]);
      expect(await threadModel.findById('understanding-thread')).toBeDefined();
    });
  });

  describe('findById', () => {
    it('should return a thread by id', async () => {
      await serverDB.insert(threads).values({
        id: 'thread-1',
        topicId,
        type: ThreadType.Standalone,
        status: ThreadStatus.Active,
        userId,
        title: 'Test Thread',
      });

      const result = await threadModel.findById('thread-1');

      expect(result).toBeDefined();
      expect(result?.id).toBe('thread-1');
      expect(result?.title).toBe('Test Thread');
    });

    it('should return undefined for non-existent thread', async () => {
      const result = await threadModel.findById('non-existent');

      expect(result).toBeUndefined();
    });

    it('should not return thread belonging to another user', async () => {
      await serverDB.transaction(async (tx) => {
        await tx.insert(topics).values({ id: 'other-topic', userId: otherUserId });
        await tx.insert(threads).values({
          id: 'thread-other',
          topicId: 'other-topic',
          type: ThreadType.Standalone,
          status: ThreadStatus.Active,
          userId: otherUserId,
        });
      });

      const result = await threadModel.findById('thread-other');

      expect(result).toBeUndefined();
    });
  });

  describe('update', () => {
    it('should update a thread', async () => {
      await serverDB.insert(threads).values({
        id: 'thread-1',
        topicId,
        type: ThreadType.Standalone,
        status: ThreadStatus.Active,
        userId,
        title: 'Original Title',
      });

      await threadModel.update('thread-1', {
        title: 'Updated Title',
        status: ThreadStatus.Completed,
      });

      const updated = await serverDB.query.threads.findFirst({
        where: eq(threads.id, 'thread-1'),
      });

      expect(updated?.title).toBe('Updated Title');
      expect(updated?.status).toBe(ThreadStatus.Completed);
    });

    it('should not update thread belonging to another user', async () => {
      await serverDB.transaction(async (tx) => {
        await tx.insert(topics).values({ id: 'other-topic', userId: otherUserId });
        await tx.insert(threads).values({
          id: 'thread-other',
          topicId: 'other-topic',
          type: ThreadType.Standalone,
          status: ThreadStatus.Active,
          userId: otherUserId,
          title: 'Original Title',
        });
      });

      await threadModel.update('thread-other', { title: 'Hacked Title' });

      const unchanged = await serverDB.query.threads.findFirst({
        where: eq(threads.id, 'thread-other'),
      });

      expect(unchanged?.title).toBe('Original Title');
    });
  });

  describe('claimForRun', () => {
    const insertThread = (values: Partial<typeof threads.$inferInsert> = {}) =>
      serverDB.insert(threads).values({
        id: 'thread-claim',
        metadata: { operationId: 'op-old' },
        status: ThreadStatus.Failed,
        topicId,
        type: ThreadType.Isolation,
        userId,
        ...values,
      });

    it('moves the thread to processing when it still matches the validated run', async () => {
      await insertThread();

      const claimed = await threadModel.claimForRun(
        'thread-claim',
        { operationId: 'op-old', status: ThreadStatus.Failed },
        { startedAt: '2026-09-25T00:00:00.000Z' },
      );

      const row = await serverDB.query.threads.findFirst({ where: eq(threads.id, 'thread-claim') });
      expect(claimed).toBe(true);
      expect(row?.status).toBe(ThreadStatus.Processing);
      expect(row?.metadata).toEqual({ startedAt: '2026-09-25T00:00:00.000Z' });
    });

    it('lets only one of two concurrent claims win', async () => {
      await insertThread();
      const expected = { operationId: 'op-old', status: ThreadStatus.Failed };

      const results = await Promise.all([
        threadModel.claimForRun('thread-claim', expected, { startedAt: 'a' }),
        threadModel.claimForRun('thread-claim', expected, { startedAt: 'b' }),
      ]);

      expect(results.filter(Boolean)).toHaveLength(1);
    });

    it('refuses when the thread moved on since it was read', async () => {
      await insertThread({ metadata: { operationId: 'op-new' } });

      await expect(
        threadModel.claimForRun(
          'thread-claim',
          { operationId: 'op-old', status: ThreadStatus.Failed },
          { startedAt: 'a' },
        ),
      ).resolves.toBe(false);
    });

    it('matches a thread that never recorded a run id', async () => {
      await insertThread({ metadata: null, status: ThreadStatus.Active });

      await expect(
        threadModel.claimForRun(
          'thread-claim',
          { status: ThreadStatus.Active },
          { startedAt: 'a' },
        ),
      ).resolves.toBe(true);
    });

    it('does not claim a thread owned by another user', async () => {
      await serverDB.transaction(async (tx) => {
        await tx.insert(topics).values({ id: 'other-topic', userId: otherUserId });
        await tx.insert(threads).values({
          id: 'thread-other',
          metadata: { operationId: 'op-old' },
          status: ThreadStatus.Failed,
          topicId: 'other-topic',
          type: ThreadType.Isolation,
          userId: otherUserId,
        });
      });

      await expect(
        threadModel.claimForRun(
          'thread-other',
          { operationId: 'op-old', status: ThreadStatus.Failed },
          { startedAt: 'a' },
        ),
      ).resolves.toBe(false);
    });
  });

  describe('delete', () => {
    it('should delete a thread', async () => {
      await serverDB.insert(threads).values({
        id: 'thread-1',
        topicId,
        type: ThreadType.Standalone,
        status: ThreadStatus.Active,
        userId,
      });

      await threadModel.delete('thread-1');

      const deleted = await serverDB.query.threads.findFirst({
        where: eq(threads.id, 'thread-1'),
      });

      expect(deleted).toBeUndefined();
    });

    it('should not delete thread belonging to another user', async () => {
      await serverDB.transaction(async (tx) => {
        await tx.insert(topics).values({ id: 'other-topic', userId: otherUserId });
        await tx.insert(threads).values({
          id: 'thread-other',
          topicId: 'other-topic',
          type: ThreadType.Standalone,
          status: ThreadStatus.Active,
          userId: otherUserId,
        });
      });

      await threadModel.delete('thread-other');

      const stillExists = await serverDB.query.threads.findFirst({
        where: eq(threads.id, 'thread-other'),
      });

      expect(stillExists).toBeDefined();
    });
  });

  describe('deleteAll', () => {
    it('should delete all threads for the current user', async () => {
      await serverDB.transaction(async (tx) => {
        await tx.insert(topics).values({ id: 'other-topic', userId: otherUserId });
        await tx.insert(threads).values([
          {
            id: 'thread-1',
            topicId,
            type: ThreadType.Standalone,
            status: ThreadStatus.Active,
            userId,
          },
          {
            id: 'thread-2',
            topicId,
            type: ThreadType.Continuation,
            status: ThreadStatus.Active,
            userId,
          },
          {
            id: 'thread-3',
            topicId: 'other-topic',
            type: ThreadType.Standalone,
            status: ThreadStatus.Active,
            userId: otherUserId,
          },
        ]);
      });

      await threadModel.deleteAll();

      const userThreads = await serverDB.select().from(threads).where(eq(threads.userId, userId));
      const otherUserThreads = await serverDB
        .select()
        .from(threads)
        .where(eq(threads.userId, otherUserId));

      expect(userThreads).toHaveLength(0);
      expect(otherUserThreads).toHaveLength(1);
    });

    it('should only clear the caller own threads in workspace mode', async () => {
      const workspaceId = 'thread-delete-workspace';
      const workspaceThreadModel = new ThreadModel(serverDB, userId, workspaceId);

      await serverDB.transaction(async (tx) => {
        await tx.insert(workspaces).values({
          id: workspaceId,
          name: 'Thread Delete Workspace',
          primaryOwnerId: userId,
          slug: workspaceId,
        });
        await tx.insert(topics).values({ id: 'ws-topic', userId, workspaceId });
        await tx.insert(threads).values([
          {
            id: 'ws-thread-mine',
            topicId: 'ws-topic',
            type: ThreadType.Standalone,
            status: ThreadStatus.Active,
            userId,
            workspaceId,
          },
          {
            id: 'ws-thread-other',
            topicId: 'ws-topic',
            type: ThreadType.Standalone,
            status: ThreadStatus.Active,
            userId: otherUserId,
            workspaceId,
          },
        ]);
      });

      await workspaceThreadModel.deleteAll();

      const remaining = await serverDB
        .select()
        .from(threads)
        .where(eq(threads.workspaceId, workspaceId));
      expect(remaining).toHaveLength(1);
      expect(remaining[0].userId).toBe(otherUserId);
    });
  });
});

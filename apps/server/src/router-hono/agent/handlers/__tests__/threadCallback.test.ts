// @vitest-environment node
import type { Context } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MessageModel } from '@/database/models/message';
import { ThreadModel } from '@/database/models/thread';
import { AiAgentService } from '@/server/services/aiAgent';

import { threadCallback } from '../threadCallback';

const mocks = vi.hoisted(() => ({
  completeRun: vi.fn(),
  findOperation: vi.fn(),
  findById: vi.fn(),
  getOperationMetadata: vi.fn(),
  loadAgentState: vi.fn(),
  loadRunMessagesFromDB: vi.fn(),
  update: vi.fn(),
  updateProgressForRun: vi.fn(),
  rows: [] as unknown[],
}));
vi.mock('@/database/core/db-adaptor', () => ({
  getServerDB: async () => ({
    transaction: async (fn: (tx: unknown) => unknown) => fn({}),
    select: () => ({ from: () => ({ where: () => ({ limit: async () => mocks.rows }) }) }),
  }),
}));
vi.mock('@/database/models/agentOperation', () => ({
  AgentOperationModel: vi.fn(function () {
    return { findById: mocks.findOperation };
  }),
}));
vi.mock('@/database/models/thread', () => ({
  ThreadModel: vi.fn(function () {
    return {
      findById: mocks.findById,
      completeRun: mocks.completeRun,
      updateProgressForRun: mocks.updateProgressForRun,
    };
  }),
}));
vi.mock('@/database/models/message', () => ({
  MessageModel: vi.fn(function () {
    return { update: mocks.update };
  }),
}));
vi.mock('@/server/modules/AgentRuntime', () => ({
  AgentRuntimeCoordinator: vi.fn(function () {
    return {
      getOperationMetadata: mocks.getOperationMetadata,
      loadAgentState: mocks.loadAgentState,
    };
  }),
}));
vi.mock('@/server/services/aiAgent', () => ({
  AiAgentService: vi.fn(function () {
    return {
      loadRunMessagesFromDB: mocks.loadRunMessagesFromDB,
    };
  }),
}));

const base = {
  runToken: 'token',
  hookType: 'afterStep',
  operationId: 'op',
  threadId: 'thread',
  startedAt: '2026-10-30T00:00:00.000Z',
  stepIndex: 2,
  steps: 3,
  toolCalls: 4,
  usageBaseline: { totalTokens: 100, totalToolCalls: 2 },
};
async function call(body: unknown = base) {
  return threadCallback({
    req: { json: async () => body },
    json: (b: unknown, status = 200) => Response.json(b, { status }),
  } as Context);
}

describe('thread callback', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.rows = [];
    mocks.findOperation.mockResolvedValue({ cost: null, usage: null, error: null });
    mocks.getOperationMetadata.mockResolvedValue({ userId: 'user', workspaceId: 'workspace' });
    mocks.findById.mockResolvedValue({
      id: 'thread',
      status: 'processing',
      metadata: { runToken: 'token', operationId: 'op' },
      topicId: 'topic',
    });
    mocks.loadAgentState.mockResolvedValue({
      operationId: 'op',
      stepCount: 8,
      usage: { llm: { tokens: { total: 30 } }, tools: { totalCalls: 9 } },
      cost: { total: 0.5 },
    });
    mocks.loadRunMessagesFromDB.mockResolvedValue({
      messages: [{ role: 'assistant', content: 'answer' }],
      lastAssistantContent: 'answer',
    });
    mocks.completeRun.mockResolvedValue(true);
    mocks.updateProgressForRun.mockResolvedValue(true);
  });

  it('writes event tool usage, DB message count and baseline-adjusted tokens', async () => {
    expect((await call()).status).toBe(200);
    expect(mocks.loadRunMessagesFromDB).toHaveBeenCalled();
    expect(ThreadModel).toHaveBeenCalledWith(expect.anything(), 'user', 'workspace');
    expect(AiAgentService).toHaveBeenCalledWith(expect.anything(), 'user', {
      includeShareVisitor: false,
      workspaceId: 'workspace',
    });
    expect(mocks.updateProgressForRun).toHaveBeenCalledWith(
      'thread',
      'token',
      'op',
      2,
      expect.objectContaining({
        totalMessages: 1,
        totalTokens: 130,
        totalToolCalls: 6,
        startedAt: base.startedAt,
      }),
    );
  });

  it.each(['completed', 'failed', 'cancel'])(
    'does not overwrite terminal %s with late progress',
    async (status) => {
      mocks.findById.mockResolvedValue({
        status,
        metadata: { runToken: 'token', operationId: 'op' },
      });
      expect((await call()).status).toBe(200);
      expect(mocks.updateProgressForRun).not.toHaveBeenCalled();
    },
  );

  it('skips progress older than the stored step', async () => {
    mocks.findById.mockResolvedValue({
      status: 'processing',
      metadata: {
        runToken: 'token',
        operationId: 'op',
        progressOperationId: 'op',
        progressStep: 5,
      },
    });
    expect((await call()).status).toBe(200);
    expect(mocks.updateProgressForRun).not.toHaveBeenCalled();
  });

  it.each(['afterStep', 'onComplete'])('ignores a retired run token for %s', async (hookType) => {
    mocks.findById.mockResolvedValue({
      status: 'processing',
      metadata: { runToken: 'retired', operationId: 'other' },
    });
    expect((await call({ ...base, hookType })).status).toBe(200);
    expect(mocks.updateProgressForRun).not.toHaveBeenCalled();
    expect(mocks.completeRun).not.toHaveBeenCalled();
  });

  it.each(['missing', 'query-failed'])(
    'retries an expired-state callback with %s durable data',
    async (mode) => {
      mocks.loadAgentState.mockResolvedValue(null);
      if (mode === 'missing') mocks.findOperation.mockResolvedValue(null);
      else mocks.findOperation.mockRejectedValue(new Error('database unavailable'));
      const response = await call({ ...base, hookType: 'onComplete', reason: 'done' });
      expect(response.status).toBeGreaterThanOrEqual(500);
      expect(mocks.completeRun).not.toHaveBeenCalled();
      expect(mocks.update).not.toHaveBeenCalled();
    },
  );

  it('recovers final cost, usage and error from the durable operation after Redis expires', async () => {
    mocks.loadAgentState.mockResolvedValue(null);
    mocks.findOperation.mockResolvedValue({
      userId: 'user',
      workspaceId: 'workspace',
      cost: { total: 2 },
      totalCost: 2,
      totalTokens: 77,
      toolCalls: 3,
      usage: { llm: { tokens: { total: 77 } }, tools: { totalCalls: 3 } },
      error: { type: 'AgentRuntimeError', message: 'durable error' },
      status: 'error',
    });
    const response = await call({ ...base, hookType: 'onComplete', reason: 'error' });
    expect(response.status).toBe(200);
    expect(mocks.completeRun).toHaveBeenCalledWith(
      'thread',
      'token',
      'op',
      'failed',
      expect.objectContaining({
        totalCost: 2,
        totalTokens: 177,
        totalToolCalls: 5,
        error: expect.objectContaining({ message: 'durable error' }),
      }),
    );
  });

  it('completes and updates the source summary', async () => {
    expect(
      (await call({ ...base, hookType: 'onComplete', reason: 'done', sourceMessageId: 'source' }))
        .status,
    ).toBe(200);
    expect(mocks.completeRun).toHaveBeenCalledWith(
      'thread',
      'token',
      'op',
      'completed',
      expect.objectContaining({
        operationId: 'op',
        totalCost: 0.5,
        totalTokens: 130,
        totalToolCalls: 11,
        totalMessages: 1,
      }),
    );
    expect(mocks.update).toHaveBeenCalledWith('source', { content: 'answer' });
    expect(MessageModel).toHaveBeenCalledWith(expect.anything(), 'user', 'workspace', undefined, {
      includeShareVisitor: false,
    });
  });

  it('does not write the summary if the completion CAS loses', async () => {
    mocks.completeRun.mockResolvedValue(false);
    await call({ ...base, hookType: 'onComplete', sourceMessageId: 'source' });
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('acknowledges duplicate completions without changing timestamps or summaries', async () => {
    await call({ ...base, hookType: 'onComplete' });
    mocks.findById.mockResolvedValue({
      status: 'completed',
      metadata: { runToken: 'token', operationId: 'op' },
    });
    expect((await call({ ...base, hookType: 'onComplete' })).status).toBe(200);
    expect(mocks.completeRun).toHaveBeenCalledTimes(1);
  });

  it('completes before the operation id is linked when the run token matches', async () => {
    mocks.findById.mockResolvedValue({ status: 'processing', metadata: { runToken: 'token' } });
    expect((await call({ ...base, hookType: 'onComplete' })).status).toBe(200);
    expect(mocks.completeRun).toHaveBeenCalledTimes(1);
  });

  it('accepts resumed step zero and completion from inReview under the renewed token', async () => {
    mocks.findById.mockResolvedValue({
      status: 'inReview',
      metadata: {
        runToken: 'token',
        operationId: 'paused',
        progressOperationId: 'paused',
        progressStep: 9,
        completedOperationId: 'paused',
      },
    });
    expect((await call({ ...base, stepIndex: 0 })).status).toBe(200);
    expect(mocks.updateProgressForRun).toHaveBeenCalledWith(
      'thread',
      'token',
      'op',
      0,
      expect.anything(),
    );
    expect((await call({ ...base, hookType: 'onComplete' })).status).toBe(200);
    expect(mocks.completeRun).toHaveBeenCalledTimes(1);
  });

  it('lets the conditional write deduplicate human waiting without assuming final completion', async () => {
    mocks.findById.mockResolvedValue({
      status: 'inReview',
      metadata: { runToken: 'token', completedOperationId: 'op' },
    });
    expect(
      (await call({ ...base, hookType: 'onComplete', reason: 'waiting_for_human' })).status,
    ).toBe(200);
    expect(mocks.completeRun).toHaveBeenCalledTimes(1);
  });

  it('ignores late callbacks carrying the retired token after approval continuation', async () => {
    mocks.findById.mockResolvedValue({
      status: 'inReview',
      metadata: { runToken: 'renewed', operationId: 'paused' },
    });
    await call();
    await call({ ...base, hookType: 'onComplete' });
    expect(mocks.completeRun).not.toHaveBeenCalled();
    expect(mocks.updateProgressForRun).not.toHaveBeenCalled();
  });

  it('preserves the share visitor message scope on summary writes', async () => {
    mocks.getOperationMetadata.mockResolvedValue({
      userId: 'creator',
      workspaceId: 'workspace',
      streamOwnerUserId: 'visitor',
    });
    await call({ ...base, hookType: 'onComplete', sourceMessageId: 'source' });
    expect(MessageModel).toHaveBeenCalledWith(
      expect.anything(),
      'creator',
      'workspace',
      undefined,
      { includeShareVisitor: true },
    );
  });

  it('accepts an omitted baseline and does not use the presentation tool tracking counter', async () => {
    await call({ ...base, totalToolCalls: 999, usageBaseline: undefined });
    expect(mocks.updateProgressForRun).toHaveBeenCalledWith(
      'thread',
      'token',
      'op',
      2,
      expect.objectContaining({ totalTokens: 30, totalToolCalls: 4 }),
    );
  });

  it('recovers messages but does not invent usage when Redis state has expired', async () => {
    mocks.loadAgentState.mockResolvedValue(null);
    await call({ ...base, hookType: 'onComplete', reason: 'error' });
    const metadata = mocks.completeRun.mock.calls[0][4];
    expect(mocks.completeRun.mock.calls[0][3]).toBe('failed');
    expect(metadata).toMatchObject({
      totalMessages: 1,
      operationId: 'op',
      startedAt: base.startedAt,
    });
    for (const key of ['totalCost', 'totalTokens', 'totalToolCalls', 'error'])
      expect(metadata).not.toHaveProperty(key);
  });

  it('skips missing threads and missing progress state', async () => {
    mocks.findById.mockResolvedValueOnce(undefined);
    expect((await call()).status).toBe(200);
    mocks.loadAgentState.mockResolvedValue(null);
    expect((await call()).status).toBe(200);
    expect(mocks.updateProgressForRun).not.toHaveBeenCalled();
  });

  it('falls back to the durable owner', async () => {
    mocks.getOperationMetadata.mockResolvedValue(null);
    mocks.rows = [{ userId: 'user', workspaceId: 'workspace' }];
    expect((await call()).status).toBe(200);
  });

  it('returns 401 without an operation owner', async () => {
    mocks.getOperationMetadata.mockResolvedValue(null);
    expect((await call()).status).toBe(401);
  });

  it.each([
    null,
    {},
    { ...base, runToken: undefined },
    { ...base, operationId: 1 },
    { ...base, threadId: ' ' },
    { ...base, startedAt: '' },
    { ...base, hookType: 'beforeStep' },
  ])('rejects invalid body %j', async (body) => {
    expect((await call(body)).status).toBe(400);
  });

  it.each(['loadAgentState', 'updateProgressForRun', 'findById', 'getOperationMetadata'])(
    'retries %s errors',
    async (method) => {
      mocks[method].mockRejectedValue(new Error('unavailable'));
      expect((await call()).status).toBe(500);
    },
  );

  it('retries a failed summary write instead of acknowledging it', async () => {
    mocks.update.mockRejectedValue(new Error('message db down'));
    expect(
      (await call({ ...base, hookType: 'onComplete', sourceMessageId: 'source' })).status,
    ).toBe(500);
  });

  it('retries message recovery failures', async () => {
    mocks.loadRunMessagesFromDB.mockRejectedValue(new Error('message db down'));
    expect((await call()).status).toBe(500);
  });

  it.each([
    ['done', 'completed'],
    ['error', 'failed'],
    ['interrupted', 'cancel'],
    ['waiting_for_human', 'inReview'],
    ['max_steps', 'completed'],
  ])('maps completion reason %s to %s', async (reason, status) => {
    await call({ ...base, hookType: 'onComplete', reason });
    expect(mocks.completeRun.mock.calls[0][3]).toBe(status);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('returns 400 on malformed JSON', async () => {
    const response = await threadCallback({
      req: {
        json: async () => {
          throw new SyntaxError('bad json');
        },
      },
      json: (body: unknown, status = 200) => Response.json(body, { status }),
    } as Context);
    expect(response.status).toBe(400);
  });

  it('retries completion database errors', async () => {
    mocks.completeRun.mockRejectedValue(new Error('db down'));
    expect((await call({ ...base, hookType: 'onComplete' })).status).toBe(500);
  });
});

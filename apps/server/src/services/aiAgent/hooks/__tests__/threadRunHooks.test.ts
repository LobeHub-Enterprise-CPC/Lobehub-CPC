// @vitest-environment node
import type { AgentHookEvent } from '@lobechat/agent-runtime';
import { ThreadStatus } from '@lobechat/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createThreadHooks } from '../threadRunHooks';

const thread = { completeRun: vi.fn(), updateProgressForRun: vi.fn() };
const message = { update: vi.fn() };
const startedAt = '2026-10-30T00:00:00.000Z';
const baseline = { totalCost: 1, totalTokens: 100, totalToolCalls: 2 };
const state = {
  cost: { total: 0.5 },
  messages: [{ content: 'answer', role: 'assistant' }],
  operationId: 'op',
  stepCount: 3,
  usage: { llm: { tokens: { total: 30 } }, tools: { totalCalls: 4 } },
};
const hooks = () =>
  createThreadHooks(
    {} as never,
    thread as never,
    message as never,
    'thread',
    startedAt,
    'source',
    'execSubAgent',
    'token',
    baseline,
  );

describe('thread run hooks', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    thread.completeRun.mockResolvedValue(true);
  });

  it('serializes lean authenticated callbacks without overriding event fields', () => {
    for (const hook of hooks()) {
      expect(hook.webhook).toMatchObject({
        body: {
          runToken: 'token',
          logScope: 'execSubAgent',
          sourceMessageId: 'source',
          startedAt,
          threadId: 'thread',
          usageBaseline: baseline,
        },
        delivery: 'qstash',
        fallback: 'none',
        url: '/api/agent/webhooks/thread-callback',
      });
      expect(hook.webhook!.eventFields).not.toContain('finalState');
      for (const field of hook.webhook!.eventFields!)
        expect(hook.webhook!.body).not.toHaveProperty(field);
    }
    expect(hooks()[0].webhook!.eventFields).toEqual([
      'operationId',
      'stepIndex',
      'steps',
      'toolCalls',
    ]);
    expect(hooks()[1].webhook!.eventFields).toEqual(['operationId', 'reason', 'status']);
  });

  it('preserves local usage and summary rules with guarded writes', async () => {
    await hooks()[0].handler!({
      finalState: state,
      operationId: 'op',
      stepIndex: 2,
    } as AgentHookEvent);
    expect(thread.updateProgressForRun).toHaveBeenCalledWith('thread', 'token', 'op', 2, {
      operationId: 'op',
      startedAt,
      totalCost: 1,
      totalMessages: 1,
      totalTokens: 130,
      totalToolCalls: 6,
    });
    await hooks()[1].handler!({
      finalState: state,
      operationId: 'op',
      reason: 'done',
    } as AgentHookEvent);
    expect(thread.completeRun).toHaveBeenCalledWith(
      'thread',
      'token',
      'op',
      ThreadStatus.Completed,
      expect.objectContaining({
        totalCost: 1.5,
        totalMessages: 1,
        totalTokens: 130,
        totalToolCalls: 6,
      }),
    );
    expect(message.update).toHaveBeenCalledWith('source', { content: 'answer' });
  });

  it.each([
    ['done', ThreadStatus.Completed],
    ['error', ThreadStatus.Failed],
    ['interrupted', ThreadStatus.Cancel],
    ['waiting_for_human', ThreadStatus.InReview],
  ])('preserves local completion reason %s', async (reason, status) => {
    await hooks()[1].handler!({
      finalState: state,
      operationId: 'resumed-op',
      reason,
    } as AgentHookEvent);
    expect(thread.completeRun).toHaveBeenCalledWith(
      'thread',
      'token',
      'resumed-op',
      status,
      expect.objectContaining({ totalMessages: 1, totalTokens: 130, totalToolCalls: 6 }),
    );
    expect(message.update).toHaveBeenCalledWith('source', { content: 'answer' });
  });

  it('serializes undefined baseline entries as absent values', () => {
    const hook = createThreadHooks(
      {} as never,
      thread as never,
      message as never,
      'thread',
      startedAt,
      undefined,
      'execVirtualSubAgent',
      'token',
      { totalTokens: undefined },
    )[0];
    expect(JSON.parse(JSON.stringify(hook.webhook!.body))).toEqual({
      runToken: 'token',
      logScope: 'execVirtualSubAgent',
      startedAt,
      threadId: 'thread',
      usageBaseline: {},
    });
  });

  it('keeps local persistence errors from interrupting execution', async () => {
    thread.updateProgressForRun.mockRejectedValue(new Error('db down'));
    await expect(
      hooks()[0].handler!({ finalState: state, operationId: 'op' } as AgentHookEvent),
    ).resolves.toBeUndefined();
  });
});

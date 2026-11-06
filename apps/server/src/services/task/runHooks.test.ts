import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { LobeChatDatabase } from '@/database/type';

import { createTaskRunHooks } from './runHooks';

const { onTopicComplete } = vi.hoisted(() => ({ onTopicComplete: vi.fn() }));

vi.mock('@/server/services/taskLifecycle', () => ({
  TOPIC_COMPLETE_HOOK_TIMEOUT_S: 777,
  TaskLifecycleService: vi.fn().mockImplementation(function () {
    return { onTopicComplete };
  }),
}));

describe('createTaskRunHooks', () => {
  const db = {} as LobeChatDatabase;

  beforeEach(() => {
    vi.clearAllMocks();
    onTopicComplete.mockResolvedValue(undefined);
  });

  it('settles the run through onTopicComplete when it ends', async () => {
    const [hook] = createTaskRunHooks({
      db,
      taskId: 'task-1',
      taskIdentifier: 'T-1',
      trigger: 'manual',
      userId: 'user-1',
    });

    expect(hook.type).toBe('onComplete');

    await hook.handler?.({
      errorMessage: 'boom',
      lastAssistantContent: 'the answer',
      operationId: 'op-1',
      reason: 'done',
      topicId: 'tpc-1',
    } as any);

    expect(onTopicComplete).toHaveBeenCalledWith({
      errorCode: undefined,
      errorMessage: 'boom',
      lastAssistantContent: 'the answer',
      operationId: 'op-1',
      reason: 'done',
      runTrigger: 'manual',
      taskId: 'task-1',
      taskIdentifier: 'T-1',
      topicId: 'tpc-1',
    });
  });

  it('defaults a run that reported no reason to a clean finish', async () => {
    const [hook] = createTaskRunHooks({
      db,
      taskId: 'task-1',
      taskIdentifier: 'T-1',
      userId: 'user-1',
    });

    await hook.handler?.({ operationId: 'op-1', topicId: 'tpc-1' } as any);

    expect(onTopicComplete).toHaveBeenCalledWith(expect.objectContaining({ reason: 'done' }));
  });

  it('gives the delivery the lifecycle timeout, not the 30s webhook default', () => {
    // The lifecycle makes its LLM calls inside the delivery; a shorter attempt
    // timeout redelivers it and reruns every paid call.
    const [hook] = createTaskRunHooks({
      db,
      taskId: 'task-1',
      taskIdentifier: 'T-1',
      userId: 'user-1',
    });

    // The lifecycle owns the value (its test checks it covers its LLM calls).
    expect(hook.webhook?.timeout).toBe(777);
  });

  it('carries the run in the static webhook body, so a lost socket still settles it', () => {
    // The production callback rebuilds the lifecycle params server-side from
    // this body — it never sees the in-process handler's closure.
    const [hook] = createTaskRunHooks({
      db,
      taskId: 'task-1',
      taskIdentifier: 'T-1',
      trigger: 'schedule',
      userId: 'user-1',
      workspaceId: 'ws-1',
    });

    expect(hook.webhook).toMatchObject({
      body: { runTrigger: 'schedule', taskId: 'task-1', taskIdentifier: 'T-1', userId: 'user-1' },
      url: '/api/workflows/task/on-topic-complete',
    });
  });
});

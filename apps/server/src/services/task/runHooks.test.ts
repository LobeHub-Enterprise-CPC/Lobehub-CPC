import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { LobeChatDatabase } from '@/database/type';
import { HATCHET_TIMING } from '@/server/modules/Hatchet/config';

import { createTaskRunHooks } from './runHooks';

const { onTopicComplete } = vi.hoisted(() => ({ onTopicComplete: vi.fn() }));

vi.mock('@/server/services/taskLifecycle', () => ({
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

  it('lets the delivery cover the slowest model call, not the 30s webhook default', () => {
    // The lifecycle makes its model calls inside the delivery; a shorter attempt
    // timeout redelivers it while it is still working and reruns every paid call.
    const [hook] = createTaskRunHooks({
      db,
      taskId: 'task-1',
      taskIdentifier: 'T-1',
      userId: 'user-1',
    });

    // Same contract as a workflow delivery (timing.test.ts keeps it inside the
    // delivery execution timeout the publisher enforces).
    expect(hook.webhook?.timeout).toBe(HATCHET_TIMING.workflowDeliveryHttpTimeoutMs / 1000);
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

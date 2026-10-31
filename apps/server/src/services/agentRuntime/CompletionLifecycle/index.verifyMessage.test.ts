// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CompletionLifecycle } from '.';

// One message table for every MessageModel the lifecycle builds.
const { messages } = vi.hoisted(() => ({ messages: [] as any[] }));

vi.mock('@/database/models/message', () => ({
  MessageModel: vi.fn(function () {
    return {
      create: vi.fn(async (message: any) => {
        messages.push(message);
        return { id: `msg-${messages.length}`, ...message };
      }),
      findVerifyMessageByOperationId: vi.fn(async (operationId: string) =>
        messages.find(
          (message) =>
            message.role === 'verify' && message.metadata?.verifyOperationId === operationId,
        ),
      ),
    };
  }),
}));
vi.mock('@/database/models/agentOperation', () => ({
  AgentOperationModel: vi.fn(function () {
    return { findById: vi.fn(async () => ({ agentId: 'agt-1', topicId: 'tpc-1' })) };
  }),
}));
vi.mock('@/database/models/verifyRun', () => ({
  VerifyRunModel: vi.fn(function () {
    return { findByOperation: vi.fn(async () => ({ plan: [{ id: 'check-1' }] })) };
  }),
}));

beforeEach(() => {
  messages.length = 0;
});

describe('CompletionLifecycle verify card', () => {
  // Hatchet replays an owed completion lifecycle in full (see
  // `replayPendingCompletionLifecycle`); the card must not be duplicated.
  it('creates one delivery-checker card per Agent Run, however often completion runs', async () => {
    const lifecycle = new CompletionLifecycle({} as any, 'user-1');
    const createVerifyMessage = (lifecycle as any).createVerifyMessage.bind(lifecycle);

    await createVerifyMessage('op-1', 'msg-assistant', 'user-1');
    await createVerifyMessage('op-1', 'msg-assistant', 'user-1');

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      metadata: { verifyOperationId: 'op-1' },
      parentId: 'msg-assistant',
      role: 'verify',
      topicId: 'tpc-1',
    });
  });

  it('still creates the card of another Agent Run in the same topic', async () => {
    const lifecycle = new CompletionLifecycle({} as any, 'user-1');
    const createVerifyMessage = (lifecycle as any).createVerifyMessage.bind(lifecycle);

    await createVerifyMessage('op-1', 'msg-a', 'user-1');
    await createVerifyMessage('op-2', 'msg-b', 'user-1');

    expect(messages.map((message) => message.metadata.verifyOperationId)).toEqual(['op-1', 'op-2']);
  });
});
